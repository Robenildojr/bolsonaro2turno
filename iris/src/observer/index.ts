/**
 * Observador de contexto.
 *
 * Você pediu que ela acompanhasse o que você faz, para ser um segundo cérebro.
 * Isto faz isso — e é, de longe, o módulo mais sensível do sistema. O que segue
 * são as decisões de projeto e o porquê de cada uma.
 *
 * **Nunca liga sozinho.** Não há caminho em que o observador comece a gravar
 * sem você mandar. Nem no primeiro uso, nem depois de uma atualização, nem
 * porque "seria útil".
 *
 * **Fica visível enquanto grava.** Um indicador permanente na tela. Vigilância
 * que você esquece que existe deixa de ser ferramenta e vira armadilha.
 *
 * **Filtra antes de gravar.** Senha, token, cartão e janela de gerenciador de
 * senhas nunca chegam ao disco. O filtro roda antes da escrita, não depois.
 *
 * **Não captura tela nem teclas.** Um registrador de teclas capturaria a sua
 * senha no ato de digitar, e nenhuma limpeza posterior desfaz o que já foi
 * escrito em disco.
 *
 * **Esquece sozinho.** As observações cruas são apagadas depois de N dias. O
 * que sobrevive é o que virou memória, que é o ponto — o objetivo é ela te
 * entender, não manter um dossiê.
 *
 * Uma consequência que merece ser dita em voz alta: se você é advogado, o que
 * você copia inclui informação de cliente coberta por sigilo profissional.
 * Ligar isto é uma decisão que envolve terceiros que não estão na conversa.
 */
import { createHash } from 'node:crypto';
import { loadConfig, saveConfig, type Config } from '../config.js';
import { getStore } from '../core/db/database.js';
import { getMemory } from '../core/memory/index.js';
import { getBroker } from '../core/permissions/broker.js';
import { getAudit } from '../core/permissions/audit.js';
import { bus } from '../core/events/bus.js';
import { id as newId } from '../util/ids.js';
import { createLogger, describeError } from '../util/logger.js';
import { extractStructured } from '../core/llm.js';
import { DAY } from '../util/time.js';
import { capturar, descreverPlataforma, verificarDisponibilidade } from './capture.js';

const log = createLogger('observador');

/** Janelas em que não se captura nada, nem o título. */
const JANELAS_PROIBIDAS =
  /(1password|bitwarden|lastpass|keepass|dashlane|keychain|gnome-keyring|seahorse|chaves|carteira|banco|internet banking|nubank|itau|bradesco|santander|caixa|banco do brasil)/i;

/** Trechos que nunca são gravados, mesmo dentro de um texto maior. */
const PADROES_PROIBIDOS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/,
  /\bsk-[A-Za-z0-9_\-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bya29\.[A-Za-z0-9_\-]{20,}/,
  /\bAIza[A-Za-z0-9_\-]{20,}/,
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/,
];

export interface EstadoObservador {
  ativo: boolean;
  pausado: boolean;
  fontes: string[];
  plataforma: string;
  capturasHoje: number;
  ultimaCaptura: number | null;
  retencaoDias: number;
}

export class Observador {
  private timer: NodeJS.Timeout | null = null;
  private pausado = false;
  private ultimoHashClipboard = '';
  private ultimaJanela = '';
  private capturasHoje = 0;
  private ultimaCaptura: number | null = null;
  private diaCorrente = '';

  constructor(private cfg: Config = loadConfig()) {}

  get ativo(): boolean {
    return this.timer !== null;
  }

  /**
   * Liga a captura. Passa pelo broker de permissões com risco crítico — e o
   * texto do pedido diz exatamente o que vai acontecer.
   */
  async ligar(fontes: { clipboard: boolean; janela: boolean }, opts: { jaAutorizado?: boolean } = {}): Promise<boolean> {
    if (this.ativo) {
      log.info('observador já estava ligado');
      return true;
    }

    const quais = [fontes.clipboard && 'área de transferência', fontes.janela && 'janela ativa']
      .filter(Boolean)
      .join(' e ');
    if (!quais) return false;

    if (!opts.jaAutorizado) {
      const decisao = await getBroker().request({
        capability: 'observador.ligar',
        scope: quais,
        reason:
          `Gravar continuamente ${quais} enquanto estiver ligado. ` +
          'Tudo que você copiar pode ser gravado — inclusive informação de clientes e de terceiros.',
        details: {
          plataforma: descreverPlataforma(),
          intervalo_segundos: this.cfg.observer.intervalMs / 1000,
          retencao_dias: RETENCAO_DIAS,
        },
      });
      if (!decisao.allowed) {
        log.info('observador não foi autorizado');
        return false;
      }
    }

    const disponivel = await verificarDisponibilidade();
    if (fontes.clipboard && !disponivel.clipboard) {
      log.warn('não consigo ler a área de transferência neste sistema', { faltando: disponivel.faltando });
    }
    if (fontes.janela && !disponivel.janela) {
      log.warn('não consigo ler a janela ativa neste sistema', { faltando: disponivel.faltando });
    }
    if (!disponivel.clipboard && !disponivel.janela) {
      log.error('nenhuma fonte disponível — observador não vai ligar', { faltando: disponivel.faltando });
      return false;
    }

    saveConfig({
      observer: {
        enabled: true,
        clipboard: fontes.clipboard && disponivel.clipboard,
        activeWindow: fontes.janela && disponivel.janela,
      },
    });
    this.cfg = loadConfig({ reload: true });

    this.pausado = false;
    this.timer = setInterval(() => void this.tick(), Math.max(1000, this.cfg.observer.intervalMs));

    getAudit().record({
      action: 'observador.ligado',
      capability: 'observador.ligar',
      scope: quais,
      detail: { fontes: quais, plataforma: descreverPlataforma() },
    });
    bus.emit('observer:state', { active: true, sources: quais.split(' e ') });
    log.warn(`OBSERVADOR LIGADO — gravando ${quais}`, { plataforma: descreverPlataforma() });
    return true;
  }

  desligar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    saveConfig({ observer: { enabled: false } });
    this.cfg = loadConfig({ reload: true });

    getAudit().record({ action: 'observador.desligado', detail: {} });
    bus.emit('observer:state', { active: false, sources: [] });
    log.info('observador desligado');
  }

  /** Pausa sem desligar — para aquele momento em que você vai digitar algo. */
  pausar(minutos = 15): void {
    this.pausado = true;
    bus.emit('observer:state', { active: false, sources: ['pausado'] });
    log.info('observador pausado', { minutos });
    setTimeout(
      () => {
        if (this.ativo) {
          this.pausado = false;
          bus.emit('observer:state', { active: true, sources: this.fontes() });
          log.info('observador retomado');
        }
      },
      minutos * 60_000,
    ).unref?.();
  }

  retomar(): void {
    this.pausado = false;
    if (this.ativo) bus.emit('observer:state', { active: true, sources: this.fontes() });
  }

  estado(): EstadoObservador {
    return {
      ativo: this.ativo,
      pausado: this.pausado,
      fontes: this.fontes(),
      plataforma: descreverPlataforma(),
      capturasHoje: this.capturasHoje,
      ultimaCaptura: this.ultimaCaptura,
      retencaoDias: RETENCAO_DIAS,
    };
  }

  private fontes(): string[] {
    return [
      this.cfg.observer.clipboard && 'área de transferência',
      this.cfg.observer.activeWindow && 'janela ativa',
    ].filter((f): f is string => Boolean(f));
  }

  // ── laço de captura ────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.pausado) return;

    try {
      const hoje = new Date().toISOString().slice(0, 10);
      if (hoje !== this.diaCorrente) {
        this.diaCorrente = hoje;
        this.capturasHoje = 0;
        this.limparAntigas();
      }

      const { clipboard, janela } = await capturar();

      // Janela proibida bloqueia a captura inteira, não só o título: o que está
      // na área de transferência naquele momento provavelmente veio dali.
      if (janela && JANELAS_PROIBIDAS.test(janela)) {
        log.debug('janela sensível — nada capturado neste ciclo');
        return;
      }

      if (this.cfg.observer.activeWindow && janela && janela !== this.ultimaJanela) {
        this.ultimaJanela = janela;
        this.gravar('janela', janela, janela);
      }

      if (this.cfg.observer.clipboard && clipboard) {
        const hash = createHash('sha256').update(clipboard).digest('hex');
        if (hash !== this.ultimoHashClipboard) {
          this.ultimoHashClipboard = hash;
          const limpo = filtrar(clipboard, this.cfg);
          if (limpo) this.gravar('clipboard', limpo, this.ultimaJanela);
        }
      }
    } catch (err) {
      log.debug('ciclo de captura falhou', { erro: describeError(err) });
    }
  }

  private gravar(fonte: 'clipboard' | 'janela', conteudo: string, app: string): void {
    const store = getStore();
    const texto = conteudo.slice(0, 20_000);
    const hash = createHash('sha256').update(`${fonte}:${texto}`).digest('hex').slice(0, 32);

    // Mesma coisa copiada de novo no mesmo dia não precisa virar linha nova.
    const jaTem = store.db
      .prepare('SELECT 1 FROM observations WHERE hash = ? AND at > ?')
      .get(hash, Date.now() - DAY);
    if (jaTem) return;

    const observacaoId = newId('obs');
    store.db
      .prepare(
        `INSERT INTO observations (id, source, at, app, hash, content_enc, processed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        observacaoId,
        fonte,
        Date.now(),
        app.slice(0, 200),
        hash,
        store.encText(texto, `observations:content:${observacaoId}`),
      );

    this.capturasHoje++;
    this.ultimaCaptura = Date.now();
  }

  /** Apaga observações cruas vencidas. */
  private limparAntigas(): void {
    const corte = Date.now() - RETENCAO_DIAS * DAY;
    const res = getStore().db.prepare('DELETE FROM observations WHERE at < ?').run(corte);
    if (res.changes > 0) log.info('observações antigas descartadas', { total: res.changes, dias: RETENCAO_DIAS });
  }

  // ── digestão ───────────────────────────────────────────────────────────────

  /**
   * Transforma observações cruas em memória.
   *
   * Clipboard cru é ruído: trechos de código, URLs, pedaços de texto sem
   * contexto. O que tem valor é o padrão — no que ele trabalhou hoje, que
   * cliente apareceu, que assunto voltou. Isso roda uma vez por dia, resume, e
   * o material cru segue seu prazo de validade normalmente.
   */
  async digerir(limite = 120): Promise<number> {
    const store = getStore();
    const rows = store.db
      .prepare('SELECT * FROM observations WHERE processed = 0 ORDER BY at ASC LIMIT ?')
      .all(limite) as Array<{ id: string; source: string; at: number; app: string | null; content_enc: Buffer }>;

    if (rows.length < 10) return 0;

    const material = rows
      .map((r) => {
        const conteudo = store.decText(r.content_enc, `observations:content:${r.id}`);
        const hora = new Date(r.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `[${hora}] ${r.source === 'janela' ? 'JANELA' : 'COPIOU'}: ${conteudo.slice(0, 600)}`;
      })
      .join('\n')
      .slice(0, 40_000);

    const resultado = await extractStructured<{
      observacoes: Array<{ assunto: string; conteudo: string; importancia: number }>;
    }>({
      system: `Você analisa o registro de atividade do dono de uma assistente pessoal: o que ele copiou e em que janelas trabalhou.

O material cru é ruído — trechos soltos, URLs, pedaços de texto. Seu trabalho é achar o que tem valor duradouro:
- em que ele trabalhou (processos, clientes, assuntos);
- ferramentas e sistemas que ele usa de fato;
- padrões de rotina que se repetem.

NÃO registre: conteúdo literal do que foi copiado, dados pessoais de terceiros, nada que pareça credencial. Registre o padrão, não o dado.

Se o material for só ruído, devolva lista vazia. Na maioria dos dias essa é a resposta certa.`,
      prompt: `Atividade registrada:\n${material}`,
      toolName: 'registrar_observacoes',
      toolDescription: 'Registra o que a atividade do dia revelou.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['observacoes'],
        properties: {
          observacoes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['assunto', 'conteudo', 'importancia'],
              properties: {
                assunto: { type: 'string' },
                conteudo: { type: 'string' },
                importancia: { type: 'number' },
              },
            },
          },
        },
      },
      effort: 'low',
      maxTokens: 3000,
    });

    let gravadas = 0;
    for (const item of resultado?.observacoes ?? []) {
      if (!item.conteudo?.trim()) continue;
      await getMemory().remember({
        kind: 'insight',
        subject: item.assunto,
        content: item.conteudo,
        importance: Math.min(0.7, item.importancia ?? 0.4),
        confidence: 0.6,
        source: 'observador',
      });
      gravadas++;
    }

    const marcar = store.db.prepare('UPDATE observations SET processed = 1 WHERE id = ?');
    store.transaction(() => {
      for (const r of rows) marcar.run(r.id);
    });

    if (gravadas > 0) log.info('observações digeridas', { cruas: rows.length, memorias: gravadas });
    return gravadas;
  }

  /** Apaga tudo que foi observado. Sem confirmação aqui — quem chama confirma. */
  apagarTudo(): number {
    const res = getStore().db.prepare('DELETE FROM observations').run();
    getAudit().record({ action: 'observador.apagado', detail: { total: res.changes } });
    log.info('todas as observações foram apagadas', { total: res.changes });
    return res.changes;
  }

  contar(): { total: number; naoProcessadas: number; maisAntiga: number | null } {
    const db = getStore().db;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n;
    const naoProcessadas = (
      db.prepare('SELECT COUNT(*) AS n FROM observations WHERE processed = 0').get() as { n: number }
    ).n;
    const maisAntiga = (
      db.prepare('SELECT MIN(at) AS m FROM observations').get() as { m: number | null }
    ).m;
    return { total, naoProcessadas, maisAntiga };
  }
}

/** Dias que uma observação crua sobrevive. */
export const RETENCAO_DIAS = 30;

/**
 * Filtro de conteúdo. Roda **antes** da gravação.
 *
 * Retorna null quando o trecho não deve ser gravado de jeito nenhum.
 */
export function filtrar(texto: string, cfg: Config = loadConfig()): string | null {
  const limpo = texto.trim();
  if (limpo.length < 3) return null;
  // Texto muito curto costuma ser fragmento sem valor; muito longo costuma ser
  // um arquivo inteiro, que não é o que este módulo existe para guardar.
  if (limpo.length > 20_000) return null;

  for (const padrao of PADROES_PROIBIDOS) {
    if (padrao.test(limpo)) return null;
  }

  for (const bruto of cfg.observer.redactPatterns) {
    try {
      const semFlag = bruto.replace(/^\(\?i\)/, '');
      const flags = bruto.startsWith('(?i)') ? 'i' : '';
      if (new RegExp(semFlag, flags).test(limpo)) return null;
    } catch {
      // Padrão inválido na configuração não pode derrubar a captura.
    }
  }

  return limpo;
}

/** Só para teste e diagnóstico: mostra se uma janela seria bloqueada. */
export function janelaProibida(titulo: string): boolean {
  return JANELAS_PROIBIDAS.test(titulo);
}

let singleton: Observador | null = null;

export function getObservador(cfg?: Config): Observador {
  if (!singleton) singleton = new Observador(cfg);
  return singleton;
}

export async function startObserver(cfg: Config): Promise<Observador> {
  const obs = getObservador(cfg);
  // Só retoma se o próprio dono já tinha ligado antes — a configuração
  // gravada é o consentimento anterior dele, não um padrão do sistema.
  if (cfg.observer.enabled) {
    await obs.ligar(
      { clipboard: cfg.observer.clipboard, janela: cfg.observer.activeWindow },
      { jaAutorizado: true },
    );
  }
  return obs;
}

export function stopObserver(): void {
  singleton?.desligar();
}
