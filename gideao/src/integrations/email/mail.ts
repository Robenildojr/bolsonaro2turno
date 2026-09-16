/**
 * E-mail: leitura por IMAP e envio por SMTP.
 *
 * As duas bibliotecas são opcionais e carregadas sob demanda. A senha nunca
 * aparece aqui: vem do cofre pelo nome `email.senha`, resolvido no instante da
 * conexão.
 *
 * Conta do Google exige **senha de app** (com verificação em duas etapas
 * ligada); a senha normal não funciona em IMAP desde 2022.
 */
import type { Config } from '../../config.js';
import { getVault } from '../../core/vault/vault.js';
import { createLogger, describeError } from '../../util/logger.js';
import { bus } from '../../core/events/bus.js';
import type { Store } from '../../core/db/database.js';

const log = createLogger('email');

export interface Mensagem {
  uid: number;
  de: string;
  paraQuem: string;
  assunto: string;
  data: Date;
  previa: string;
  corpo: string;
  naoLida: boolean;
  temAnexo: boolean;
}

export class Email {
  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
  ) {}

  private senha(): string {
    const valor = getVault().get('email.senha');
    if (!valor) {
      throw new Error(
        'a senha do e-mail não está no cofre. Guarde com: gideao cofre set email.senha ' +
          '(no Gmail, use uma senha de app, não a senha da conta)',
      );
    }
    return valor;
  }

  /** Últimas mensagens da caixa de entrada. */
  async listar(opts: { limite?: number; apenasNaoLidas?: boolean; desde?: Date } = {}): Promise<Mensagem[]> {
    const { ImapFlow } = await this.carregarImap();
    const cliente = new ImapFlow({
      host: this.cfg.email.imapHost,
      port: this.cfg.email.imapPort,
      secure: true,
      auth: { user: this.cfg.email.user, pass: this.senha() },
      logger: false,
    });

    await cliente.connect();
    try {
      const trava = await cliente.getMailboxLock('INBOX');
      try {
        const criterio: Record<string, unknown> = {};
        if (opts.apenasNaoLidas) criterio.seen = false;
        if (opts.desde) criterio.since = opts.desde;

        const uids = (await cliente.search(
          Object.keys(criterio).length ? criterio : { all: true },
        )) as number[] | false;
        if (!uids || uids.length === 0) return [];

        const escolhidos = uids.slice(-(opts.limite ?? 20));
        const mensagens: Mensagem[] = [];

        for await (const msg of cliente.fetch(escolhidos, {
          uid: true,
          envelope: true,
          bodyStructure: true,
          source: true,
          flags: true,
        })) {
          mensagens.push(await this.converter(msg));
        }
        return mensagens.reverse();
      } finally {
        trava.release();
      }
    } finally {
      await cliente.logout().catch(() => {});
    }
  }

  async enviar(dados: {
    para: string;
    assunto: string;
    corpo: string;
    responderA?: string;
  }): Promise<string> {
    const nodemailer = await this.carregarSmtp();
    const transporte = nodemailer.createTransport({
      host: this.cfg.email.smtpHost,
      port: this.cfg.email.smtpPort,
      secure: this.cfg.email.smtpPort === 465,
      auth: { user: this.cfg.email.user, pass: this.senha() },
    });

    const info = (await transporte.sendMail({
      from: this.cfg.email.user,
      to: dados.para,
      subject: dados.assunto,
      text: dados.corpo,
      ...(dados.responderA ? { inReplyTo: dados.responderA, references: dados.responderA } : {}),
    })) as { messageId: string };

    log.info('e-mail enviado', { para: dados.para, assunto: dados.assunto });
    return info.messageId;
  }

  /**
   * Checagem periódica: procura mensagens novas e avisa sobre as que batem com
   * as regras de interesse. Guarda o último UID visto para não repetir aviso.
   */
  async verificarNovos(): Promise<number> {
    const ultimoVisto = this.store.getKv<number>('email:ultimo_uid', 0);
    const mensagens = await this.listar({ limite: 30, apenasNaoLidas: true });

    const novas = mensagens.filter((m) => m.uid > ultimoVisto);
    if (novas.length === 0) return 0;

    this.store.setKv('email:ultimo_uid', Math.max(...mensagens.map((m) => m.uid)));

    const regras = this.store.getKv<string[]>('email:regras', REGRAS_PADRAO);
    for (const m of novas) {
      const texto = `${m.de} ${m.assunto} ${m.previa}`.toLowerCase();
      const bateu = regras.find((r) => texto.includes(r.toLowerCase()));
      if (!bateu) continue;

      bus.emit('notify', {
        id: `email_${m.uid}`,
        title: `E-mail: ${m.assunto.slice(0, 60)}`,
        body: `De ${m.de}\n${m.previa.slice(0, 220)}`,
        kind: 'email',
        urgency: /intima|prazo|audi[êe]ncia|urgente/i.test(texto) ? 'high' : 'normal',
      });
    }

    log.info('caixa de entrada verificada', { novas: novas.length });
    return novas.length;
  }

  /** Regras de interesse: termos que fazem um e-mail virar aviso. */
  regras(): string[] {
    return this.store.getKv<string[]>('email:regras', REGRAS_PADRAO);
  }

  definirRegras(regras: string[]): void {
    this.store.setKv('email:regras', regras.slice(0, 60));
  }

  private async converter(msg: Record<string, unknown>): Promise<Mensagem> {
    const envelope = msg.envelope as
      | {
          from?: Array<{ address?: string; name?: string }>;
          to?: Array<{ address?: string }>;
          subject?: string;
          date?: Date;
        }
      | undefined;

    let corpo = '';
    try {
      const { simpleParser } = await this.carregarParser();
      const analisada = (await simpleParser(msg.source as Buffer)) as { text?: string; html?: string };
      corpo = analisada.text ?? stripHtml(analisada.html ?? '');
    } catch (err) {
      log.debug('não consegui extrair o corpo', { erro: describeError(err) });
    }

    const remetente = envelope?.from?.[0];
    const flags = msg.flags as Set<string> | undefined;

    return {
      uid: Number(msg.uid),
      de: remetente?.name ? `${remetente.name} <${remetente.address ?? ''}>` : remetente?.address ?? '',
      paraQuem: envelope?.to?.[0]?.address ?? '',
      assunto: envelope?.subject ?? '(sem assunto)',
      data: envelope?.date ?? new Date(),
      previa: corpo.replace(/\s+/g, ' ').trim().slice(0, 300),
      corpo,
      naoLida: !flags?.has('\\Seen'),
      temAnexo: JSON.stringify(msg.bodyStructure ?? {}).includes('attachment'),
    };
  }

  private async carregarImap(): Promise<{ ImapFlow: new (opts: Record<string, unknown>) => ImapClient }> {
    try {
      const modulo = 'imapflow';
      return (await import(modulo)) as unknown as {
        ImapFlow: new (opts: Record<string, unknown>) => ImapClient;
      };
    } catch {
      throw new Error('a biblioteca de IMAP não está instalada. Rode: npm install imapflow mailparser');
    }
  }

  private async carregarSmtp(): Promise<{
    createTransport(opts: Record<string, unknown>): { sendMail(m: Record<string, unknown>): Promise<unknown> };
  }> {
    try {
      const modulo = 'nodemailer';
      const mod = (await import(modulo)) as unknown as Record<string, unknown>;
      return (mod.default ?? mod) as {
        createTransport(opts: Record<string, unknown>): {
          sendMail(m: Record<string, unknown>): Promise<unknown>;
        };
      };
    } catch {
      throw new Error('a biblioteca de SMTP não está instalada. Rode: npm install nodemailer');
    }
  }

  private async carregarParser(): Promise<{ simpleParser(fonte: Buffer): Promise<unknown> }> {
    // Especificador em variável: a biblioteca é opcional e pode não estar
    // instalada, então o compilador não deve exigir os tipos dela.
    const modulo = 'mailparser';
    return (await import(modulo)) as unknown as { simpleParser(fonte: Buffer): Promise<unknown> };
  }
}

interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(caixa: string): Promise<{ release(): void }>;
  search(criterio: Record<string, unknown>): Promise<number[] | false>;
  fetch(range: number[], opts: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}

const REGRAS_PADRAO = [
  'intimação',
  'intimacao',
  'audiência',
  'audiencia',
  'prazo',
  'tribunal',
  'jus.br',
  'oab',
  'perícia',
  'pericia',
];

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let singleton: Email | null = null;

export function initEmail(cfg: Config, store: Store): Email {
  singleton = new Email(cfg, store);
  return singleton;
}

export function getEmail(): Email {
  if (!singleton) throw new Error('e-mail não configurado');
  return singleton;
}
