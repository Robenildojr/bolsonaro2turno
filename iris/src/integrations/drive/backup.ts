/**
 * Serviço de backup.
 *
 * Duas cópias, sempre:
 *
 *  - **local**, em `~/.iris/backups` — é a que salva o caso comum (você apagou
 *    algo sem querer, o banco corrompeu). Funciona sem internet e sem conta.
 *  - **Drive**, quando configurado — é a que salva o caso raro e grave: o
 *    computador se perdeu inteiro.
 *
 * As duas contêm o mesmo arquivo cifrado. O Drive nunca vê o conteúdo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, paths, type Config } from '../../config.js';
import { getStore } from '../../core/db/database.js';
import { getVault } from '../../core/vault/vault.js';
import { getKeyring } from '../../core/crypto/keyring.js';
import { getAudit } from '../../core/permissions/audit.js';
import { createLogger, describeError } from '../../util/logger.js';
import { DriveClient, type ArquivoDrive } from './client.js';
import { coletar, desempacotar, empacotar, nomeDoArquivo, resumirBackup, type ConteudoBackup } from './bundle.js';

const log = createLogger('backup');

export interface ResultadoBackup {
  arquivo: string;
  bytes: number;
  local: string;
  drive: ArquivoDrive | null;
  resumo: string;
}

export class Backup {
  private drive: DriveClient;

  constructor(private readonly cfg: Config = loadConfig()) {
    this.drive = new DriveClient(cfg.drive.clientId, cfg.drive.clientSecret);
  }

  get driveConfigurado(): boolean {
    return this.cfg.drive.enabled && this.drive.configurado;
  }

  get driveAutorizado(): boolean {
    try {
      return this.drive.autorizado;
    } catch {
      return false;
    }
  }

  async autorizarDrive(): Promise<void> {
    await this.drive.autorizar();
  }

  /**
   * Gera o pacote e guarda. A senha-mestra é necessária porque a chave do
   * arquivo é derivada dela — é isso que permite restaurar em outra máquina.
   */
  async executar(senhaMestra: string, opts: { enviarAoDrive?: boolean } = {}): Promise<ResultadoBackup> {
    const inicio = Date.now();
    const conteudo = coletar(getStore(), getVault(), {
      assistente: this.cfg.assistantName,
      dono: this.cfg.ownerName,
    });

    const pacote = empacotar(conteudo, senhaMestra);
    const nome = nomeDoArquivo();

    // cópia local
    const pastaLocal = paths(this.cfg).backups;
    await fs.mkdir(pastaLocal, { recursive: true, mode: 0o700 });
    const caminhoLocal = path.join(pastaLocal, nome);
    await fs.writeFile(caminhoLocal, pacote, { mode: 0o600 });
    await this.podarLocais(pastaLocal);

    // cópia no Drive
    let noDrive: ArquivoDrive | null = null;
    const querDrive = opts.enviarAoDrive ?? this.driveConfigurado;
    if (querDrive) {
      try {
        const pastaId = await this.drive.pasta(this.cfg.drive.folderName);
        noDrive = await this.drive.enviar(pastaId, nome, pacote);
        await this.podarDrive(pastaId);
      } catch (err) {
        // Falha no Drive não invalida o backup: a cópia local já está feita.
        log.warn('não consegui enviar ao Drive — a cópia local está salva', {
          erro: describeError(err),
        });
      }
    }

    const resultado: ResultadoBackup = {
      arquivo: nome,
      bytes: pacote.length,
      local: caminhoLocal,
      drive: noDrive,
      resumo: resumirBackup(conteudo),
    };

    getAudit().record({
      action: 'backup.executado',
      ok: true,
      durationMs: Date.now() - inicio,
      detail: { arquivo: nome, bytes: pacote.length, drive: Boolean(noDrive) },
    });
    log.info('backup concluído', {
      arquivo: nome,
      kb: Math.round(pacote.length / 1024),
      drive: Boolean(noDrive),
    });

    return resultado;
  }

  /** Lê um pacote (local ou do Drive) sem alterar nada. */
  async inspecionar(origem: { arquivo?: string; driveId?: string }, senhaMestra: string): Promise<ConteudoBackup> {
    const bytes = origem.driveId
      ? await this.drive.baixar(origem.driveId)
      : await fs.readFile(origem.arquivo!);
    return desempacotar(bytes, senhaMestra);
  }

  async listarLocais(): Promise<Array<{ arquivo: string; caminho: string; bytes: number; em: Date }>> {
    const pasta = paths(this.cfg).backups;
    try {
      const nomes = await fs.readdir(pasta);
      const itens = await Promise.all(
        nomes
          .filter((n) => n.endsWith('.iris'))
          .map(async (n) => {
            const caminho = path.join(pasta, n);
            const stat = await fs.stat(caminho);
            return { arquivo: n, caminho, bytes: stat.size, em: stat.mtime };
          }),
      );
      return itens.sort((a, b) => b.em.getTime() - a.em.getTime());
    } catch {
      return [];
    }
  }

  async listarNoDrive(): Promise<ArquivoDrive[]> {
    const pastaId = await this.drive.pasta(this.cfg.drive.folderName);
    return this.drive.listar(pastaId);
  }

  /**
   * Restaura um pacote sobre o banco atual.
   *
   * Política: **acrescenta, não substitui**. Registros com o mesmo id são
   * ignorados. Restaurar nunca apaga o que existe hoje — se o backup fosse
   * antigo, sobrescrever significaria perder tudo o que veio depois dele.
   */
  async restaurar(conteudo: ConteudoBackup): Promise<Record<string, number>> {
    const store = getStore();
    const vault = getVault();
    const contagem: Record<string, number> = {
      memorias: 0,
      conversas: 0,
      mensagens: 0,
      cofre: 0,
      lembretes: 0,
      tarefas: 0,
      processos: 0,
      autorizacoes: 0,
    };

    store.transaction(() => {
      for (const m of conteudo.memorias as Array<Record<string, any>>) {
        const existe = store.db.prepare('SELECT 1 FROM memories WHERE id = ?').get(m.id);
        if (existe) continue;
        store.db
          .prepare(
            `INSERT INTO memories (id, kind, subject, content_enc, importance, confidence, source,
                                   conversation_id, embedding, created_at, updated_at, last_used_at,
                                   use_count, pinned, expires_at, superseded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.id,
            m.kind,
            m.subject,
            store.encText(String(m.content ?? ''), `memories:content:${m.id}`),
            m.importance ?? 0.5,
            m.confidence ?? 0.8,
            m.source ?? 'backup',
            m.conversation_id ?? null,
            m.embedding ? Buffer.from(String(m.embedding), 'base64') : null,
            m.created_at ?? Date.now(),
            m.updated_at ?? Date.now(),
            m.last_used_at ?? null,
            m.use_count ?? 0,
            m.pinned ?? 0,
            m.expires_at ?? null,
            m.superseded_by ?? null,
          );
        const termo = store.db.prepare('INSERT OR IGNORE INTO memory_terms (memory_id, term) VALUES (?, ?)');
        for (const t of (m.termos ?? []) as string[]) termo.run(m.id, t);
        contagem.memorias!++;
      }

      for (const c of conteudo.conversas as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(c.id)) continue;
        store.db
          .prepare(
            `INSERT INTO conversations (id, channel, title_enc, summary_enc, started_at, updated_at, message_count, archived)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            c.id,
            c.channel ?? 'web',
            store.encText(String(c.title ?? ''), `conversations:title:${c.id}`),
            store.encText(String(c.summary ?? ''), `conversations:summary:${c.id}`),
            c.started_at ?? Date.now(),
            c.updated_at ?? Date.now(),
            c.message_count ?? 0,
            c.archived ?? 0,
          );
        contagem.conversas!++;
      }

      for (const m of conteudo.mensagens as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(m.id)) continue;
        // Mensagem cuja conversa não veio no pacote ficaria órfã.
        if (!store.db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(m.conversation_id)) continue;
        store.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, seq, role, content_enc, blocks_enc, channel, tokens_in, tokens_out, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.id,
            m.conversation_id,
            m.seq,
            m.role,
            store.encText(String(m.content ?? ''), `messages:content:${m.id}`),
            m.blocks ? store.encJson(m.blocks, `messages:blocks:${m.id}`) : null,
            m.channel ?? 'web',
            m.tokens_in ?? 0,
            m.tokens_out ?? 0,
            m.created_at ?? Date.now(),
          );
        contagem.mensagens!++;
      }

      for (const l of conteudo.lembretes as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM reminders WHERE id = ?').get(l.id)) continue;
        store.db
          .prepare(
            `INSERT INTO reminders (id, title_enc, body_enc, due_at, lead_minutes, rrule, kind, status,
                                    created_at, notified_at, done_at, source, related_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            l.id,
            store.encText(String(l.title ?? ''), `reminders:title:${l.id}`),
            store.encText(String(l.body ?? ''), `reminders:body:${l.id}`),
            l.due_at,
            l.lead_minutes ?? 60,
            l.rrule ?? null,
            l.kind ?? 'compromisso',
            l.status ?? 'pendente',
            l.created_at ?? Date.now(),
            l.notified_at ?? null,
            l.done_at ?? null,
            l.source ?? 'backup',
            l.related_id ?? null,
          );
        contagem.lembretes!++;
      }

      for (const t of conteudo.tarefas as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(t.id)) continue;
        store.db
          .prepare(
            `INSERT INTO tasks (id, title_enc, notes_enc, status, priority, due_at, project, created_at, updated_at, done_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            t.id,
            store.encText(String(t.title ?? ''), `tasks:title:${t.id}`),
            store.encText(String(t.notes ?? ''), `tasks:notes:${t.id}`),
            t.status ?? 'aberta',
            t.priority ?? 2,
            t.due_at ?? null,
            t.project ?? null,
            t.created_at ?? Date.now(),
            t.updated_at ?? Date.now(),
            t.done_at ?? null,
          );
        contagem.tarefas!++;
      }

      for (const p of conteudo.processos as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM processes WHERE number = ?').get(p.number)) continue;
        store.db
          .prepare(
            `INSERT INTO processes (id, number, tribunal, label_enc, data_enc, active, last_checked_at,
                                    last_movement_at, last_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            p.id,
            p.number,
            p.tribunal ?? '',
            store.encText(String(p.label ?? ''), `processes:label:${p.id}`),
            p.data ? store.encJson(p.data, `processes:data:${p.id}`) : null,
            p.active ?? 1,
            p.last_checked_at ?? null,
            p.last_movement_at ?? null,
            p.last_hash ?? null,
            p.created_at ?? Date.now(),
            p.updated_at ?? Date.now(),
          );
        contagem.processos!++;
      }

      for (const a of conteudo.autorizacoes as Array<Record<string, any>>) {
        if (store.db.prepare('SELECT 1 FROM capabilities WHERE id = ?').get(a.id)) continue;
        try {
          store.db
            .prepare(
              `INSERT INTO capabilities (id, capability, scope, decision, risk, granted_at, expires_at,
                                         revoked_at, use_count, last_used_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              a.id,
              a.capability,
              a.scope,
              a.decision,
              a.risk ?? 'medio',
              a.granted_at ?? Date.now(),
              a.expires_at ?? null,
              a.revoked_at ?? null,
              a.use_count ?? 0,
              a.last_used_at ?? null,
            );
          contagem.autorizacoes!++;
        } catch {
          // Índice único (capacidade, escopo): já existe uma equivalente.
        }
      }
    });

    // O cofre vai fora da transação: ele tem as próprias chaves.
    for (const c of conteudo.cofre as Array<Record<string, any>>) {
      if (!c.value || vault.has(String(c.name))) continue;
      vault.set(String(c.name), String(c.value), { kind: c.kind, meta: c.meta });
      contagem.cofre!++;
    }

    getAudit().record({ action: 'backup.restaurado', ok: true, detail: contagem });
    log.info('restauração concluída', contagem);
    return contagem;
  }

  /** Mantém as 14 cópias locais mais recentes. */
  private async podarLocais(pasta: string, manter = 14): Promise<void> {
    const arquivos = await this.listarLocais();
    for (const antigo of arquivos.slice(manter)) {
      await fs.unlink(antigo.caminho).catch(() => {});
    }
    void pasta;
  }

  /** Mantém as 30 cópias mais recentes no Drive. */
  private async podarDrive(pastaId: string, manter = 30): Promise<void> {
    try {
      const arquivos = await this.drive.listar(pastaId, 100);
      for (const antigo of arquivos.slice(manter)) {
        await this.drive.apagar(antigo.id);
      }
    } catch (err) {
      log.debug('não consegui podar backups antigos do Drive', { erro: describeError(err) });
    }
  }
}

let singleton: Backup | null = null;

export function getBackup(cfg?: Config): Backup {
  if (!singleton) singleton = new Backup(cfg);
  return singleton;
}

/** Verifica se a senha informada é mesmo a senha-mestra antes de usar no pacote. */
export function conferirSenhaMestra(senha: string): boolean {
  try {
    const kr = getKeyring();
    const estavaDestrancado = kr.unlocked;
    kr.unlock(senha);
    if (!estavaDestrancado) kr.lock();
    return true;
  } catch {
    return false;
  }
}
