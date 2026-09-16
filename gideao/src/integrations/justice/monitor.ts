/**
 * Monitor de processos.
 *
 * Roda algumas vezes por dia, compara o estado atual de cada processo
 * acompanhado com o que estava guardado e avisa só quando há movimentação nova.
 * Quando a movimentação parece marcar audiência, cria um lembrete — marcado
 * como "a confirmar", porque a extração da data é heurística e prazo processual
 * não é lugar para adivinhação.
 */
import type { Store } from '../../core/db/database.js';
import { id as newId } from '../../util/ids.js';
import { createLogger, describeError } from '../../util/logger.js';
import { bus } from '../../core/events/bus.js';
import { getAgenda } from '../../core/scheduler/agenda.js';
import { getMemory } from '../../core/memory/index.js';
import {
  DataJud,
  descreverProcesso,
  extrairAudiencia,
  formatarNumero,
  hashDoEstado,
  limparNumero,
  type Movimento,
  type ProcessoDataJud,
} from './datajud.js';

const log = createLogger('processos');

export interface ProcessoAcompanhado {
  id: string;
  numero: string;
  tribunal: string;
  rotulo: string;
  ativo: boolean;
  ultimaVerificacao: number | null;
  ultimaMovimentacao: number | null;
}

export class MonitorProcessos {
  private datajud = new DataJud();

  constructor(private readonly store: Store) {}

  /** Passa a acompanhar um processo. Faz a primeira consulta na hora. */
  async acompanhar(numero: string, rotulo = ''): Promise<{ processo: ProcessoAcompanhado; dados: ProcessoDataJud | null }> {
    const limpo = limparNumero(numero);
    if (limpo.length !== 20) {
      throw new Error(`"${numero}" não parece um número CNJ (precisa de 20 dígitos)`);
    }

    const existente = this.store.db
      .prepare('SELECT * FROM processes WHERE number = ?')
      .get(limpo) as ProcessoRow | undefined;

    const dados = await this.datajud.consultar(limpo).catch((err) => {
      log.warn('consulta inicial falhou', { numero: formatarNumero(limpo), erro: describeError(err) });
      return null;
    });

    const agora = Date.now();
    const processoId = existente?.id ?? newId('proc');

    if (existente) {
      this.store.db
        .prepare('UPDATE processes SET active = 1, label_enc = ?, updated_at = ? WHERE id = ?')
        .run(
          this.store.encText(rotulo || this.rotuloDe(existente), `processes:label:${processoId}`),
          agora,
          processoId,
        );
    } else {
      this.store.db
        .prepare(
          `INSERT INTO processes (id, number, tribunal, label_enc, data_enc, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          processoId,
          limpo,
          dados?.tribunal ?? '',
          this.store.encText(rotulo, `processes:label:${processoId}`),
          dados ? this.store.encJson(dados, `processes:data:${processoId}`) : null,
          agora,
          agora,
        );
    }

    if (dados) await this.registrar(processoId, dados, { primeiraVez: !existente });

    // O Gideão precisa saber que acompanha este processo mesmo sem consultar.
    await getMemory().remember({
      kind: 'processo',
      subject: `Processo ${formatarNumero(limpo)}`,
      content:
        `Acompanhando o processo ${formatarNumero(limpo)}` +
        (rotulo ? ` (${rotulo})` : '') +
        (dados ? `. ${dados.classe} no ${dados.orgaoJulgador || dados.tribunal}.` : '.'),
      importance: 0.8,
      confidence: 0.95,
      source: 'monitor de processos',
      pinned: true,
    });

    return { processo: this.obter(processoId)!, dados };
  }

  parar(numero: string): boolean {
    const res = this.store.db
      .prepare('UPDATE processes SET active = 0, updated_at = ? WHERE number = ?')
      .run(Date.now(), limparNumero(numero));
    return res.changes > 0;
  }

  listar(apenasAtivos = true): ProcessoAcompanhado[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM processes ${apenasAtivos ? 'WHERE active = 1' : ''}
         ORDER BY COALESCE(last_movement_at, 0) DESC`,
      )
      .all() as ProcessoRow[];
    return rows.map((r) => this.hidratar(r));
  }

  obter(processoId: string): ProcessoAcompanhado | null {
    const row = this.store.db.prepare('SELECT * FROM processes WHERE id = ?').get(processoId) as
      | ProcessoRow
      | undefined;
    return row ? this.hidratar(row) : null;
  }

  /** Varre todos os processos ativos. Chamado pelo agendador. */
  async verificarTodos(): Promise<{ verificados: number; comNovidade: number; falhas: number }> {
    const ativos = this.listar(true);
    let comNovidade = 0;
    let falhas = 0;

    for (const p of ativos) {
      try {
        const novidade = await this.verificar(p.id);
        if (novidade) comNovidade++;
        // Intervalo entre consultas: a API do CNJ é pública e gratuita, e
        // martelar não ajuda ninguém.
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        falhas++;
        log.warn('falha ao verificar processo', { numero: p.numero, erro: describeError(err) });
      }
    }

    log.info('varredura concluída', { verificados: ativos.length, comNovidade, falhas });
    return { verificados: ativos.length, comNovidade, falhas };
  }

  /** Verifica um processo. Devolve true se havia movimentação nova. */
  async verificar(processoId: string): Promise<boolean> {
    const row = this.store.db.prepare('SELECT * FROM processes WHERE id = ?').get(processoId) as
      | ProcessoRow
      | undefined;
    if (!row) return false;

    const dados = await this.datajud.consultar(row.number);
    this.store.db
      .prepare('UPDATE processes SET last_checked_at = ? WHERE id = ?')
      .run(Date.now(), processoId);

    if (!dados) return false;

    const hash = hashDoEstado(dados);
    if (hash === row.last_hash) return false;

    return this.registrar(processoId, dados, { primeiraVez: false });
  }

  /**
   * Grava os movimentos novos e avisa.
   *
   * Na primeira vez não notifica: importar um processo com 200 movimentos
   * antigos e disparar 200 avisos seria tornar a ferramenta inutilizável logo
   * no primeiro uso.
   */
  private async registrar(
    processoId: string,
    dados: ProcessoDataJud,
    opts: { primeiraVez: boolean },
  ): Promise<boolean> {
    const existentes = new Set(
      (
        this.store.db
          .prepare('SELECT hash FROM process_movements WHERE process_id = ?')
          .all(processoId) as Array<{ hash: string }>
      ).map((r) => r.hash),
    );

    const novos: Movimento[] = [];
    const inserir = this.store.db.prepare(
      `INSERT OR IGNORE INTO process_movements (id, process_id, at, hash, content_enc, notified)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.store.transaction(() => {
      for (const m of dados.movimentos) {
        const hash = `${m.data}:${m.codigo}:${m.nome}`.slice(0, 200);
        if (existentes.has(hash)) continue;
        const movimentoId = newId('mov');
        inserir.run(
          movimentoId,
          processoId,
          Date.parse(m.data) || Date.now(),
          hash,
          this.store.encJson(m, `movements:content:${movimentoId}`),
          opts.primeiraVez ? 1 : 0,
        );
        novos.push(m);
      }

      const maisRecente = dados.movimentos[0];
      this.store.db
        .prepare(
          `UPDATE processes SET data_enc = ?, tribunal = ?, last_hash = ?, last_movement_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          this.store.encJson(dados, `processes:data:${processoId}`),
          dados.tribunal,
          hashDoEstado(dados),
          maisRecente ? Date.parse(maisRecente.data) || Date.now() : null,
          Date.now(),
          processoId,
        );
    });

    if (opts.primeiraVez || novos.length === 0) return false;

    await this.avisar(dados, novos, processoId);
    return true;
  }

  private async avisar(dados: ProcessoDataJud, novos: Movimento[], processoId: string): Promise<void> {
    const rotulo = this.rotuloDe(
      this.store.db.prepare('SELECT * FROM processes WHERE id = ?').get(processoId) as ProcessoRow,
    );
    const titulo = rotulo ? `${rotulo} — movimentação` : `Movimentação em ${dados.numero}`;
    const corpo = novos
      .slice(0, 5)
      .map((m) => `• ${m.data.slice(0, 10)}: ${m.nome}`)
      .join('\n');

    bus.emit('notify', {
      id: `proc_${processoId}_${Date.now()}`,
      title: titulo,
      body: `${dados.numero}\n${corpo}${novos.length > 5 ? `\n(+${novos.length - 5} outras)` : ''}`,
      kind: 'processo',
      urgency: 'high',
    });

    // Movimentação relevante vira memória — é assim que ele conhece o caso.
    await getMemory().remember({
      kind: 'processo',
      subject: `Andamento ${dados.numero}`,
      content: `Em ${new Date().toLocaleDateString('pt-BR')}, o processo ${dados.numero} (${dados.classe}) teve: ${novos
        .slice(0, 5)
        .map((m) => m.nome)
        .join('; ')}.`,
      importance: 0.7,
      confidence: 0.95,
      source: 'DataJud/CNJ',
    });

    // Audiência encontrada vira lembrete — sempre marcado como a confirmar.
    for (const m of novos) {
      const audiencia = extrairAudiencia(m);
      if (!audiencia) continue;
      getAgenda().criarLembrete({
        titulo: `Audiência (a confirmar) — ${rotulo || dados.numero}`,
        corpo:
          `Extraído automaticamente de: "${audiencia.texto.slice(0, 200)}"\n\n` +
          'A data veio de leitura de texto da movimentação, não de campo estruturado. ' +
          'Confirme no sistema do tribunal antes de contar com ela.',
        quando: audiencia.data.getTime(),
        tipo: 'audiencia',
        origem: 'monitor de processos',
        relacionado: processoId,
      });
      log.info('audiência detectada e lembrete criado', {
        numero: dados.numero,
        data: audiencia.data.toISOString(),
      });
    }
  }

  /** Estado atual guardado, sem ir à rede. */
  ultimoEstado(numero: string): ProcessoDataJud | null {
    const row = this.store.db
      .prepare('SELECT * FROM processes WHERE number = ?')
      .get(limparNumero(numero)) as ProcessoRow | undefined;
    if (!row?.data_enc) return null;
    return this.store.decJson<ProcessoDataJud>(row.data_enc, `processes:data:${row.id}`, null as never);
  }

  descrever(numero: string): string {
    const dados = this.ultimoEstado(numero);
    return dados ? descreverProcesso(dados) : 'Não tenho dados guardados desse processo.';
  }

  private rotuloDe(row: ProcessoRow): string {
    return row.label_enc ? this.store.decText(row.label_enc, `processes:label:${row.id}`) : '';
  }

  private hidratar(row: ProcessoRow): ProcessoAcompanhado {
    return {
      id: row.id,
      numero: formatarNumero(row.number),
      tribunal: row.tribunal,
      rotulo: this.rotuloDe(row),
      ativo: row.active === 1,
      ultimaVerificacao: row.last_checked_at,
      ultimaMovimentacao: row.last_movement_at,
    };
  }
}

interface ProcessoRow {
  id: string;
  number: string;
  tribunal: string;
  label_enc: Buffer | null;
  data_enc: Buffer | null;
  active: number;
  last_checked_at: number | null;
  last_movement_at: number | null;
  last_hash: string | null;
  created_at: number;
  updated_at: number;
}

let singleton: MonitorProcessos | null = null;

export function initProcessos(store: Store): MonitorProcessos {
  singleton = new MonitorProcessos(store);
  return singleton;
}

export function getProcessos(): MonitorProcessos {
  if (!singleton) throw new Error('monitor de processos não inicializado');
  return singleton;
}
