/**
 * Provedor não oficial: Baileys.
 *
 * Conecta o seu número pessoal lendo um QR, como o WhatsApp Web. É o que a
 * maioria quer, porque usa o número que você já tem — e é também engenharia
 * reversa do protocolo da Meta.
 *
 * O que isso significa na prática, sem rodeio:
 *
 *  - viola os Termos de Serviço do WhatsApp;
 *  - o número pode ser banido, por horas, dias ou para sempre;
 *  - a Meta muda o protocolo sem aviso e a conexão quebra até a biblioteca
 *    ser atualizada;
 *  - se o número for o do seu escritório, o prejuízo de um banimento não é o
 *    do Gideão parar de funcionar: é você perder o contato com os clientes.
 *
 * Por isso a dependência não é instalada junto com o projeto e o provedor
 * exige uma confirmação explícita para subir. Se quiser mesmo:
 *
 *     npm install @whiskeysockets/baileys
 *     WHATSAPP_PROVIDER=baileys WHATSAPP_ACEITO_RISCO=sim
 */
import fs from 'node:fs';
import { paths } from '../../config.js';
import type { Config } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';
import type { MensagemRecebida, WhatsAppProvider } from './provider.js';

const log = createLogger('whatsapp:baileys');

interface BaileysSocket {
  ev: { on(evento: string, handler: (dados: unknown) => void): void };
  sendMessage(jid: string, conteudo: { text: string }): Promise<unknown>;
  logout(): Promise<void>;
  end(erro?: Error): void;
}

export class BaileysProvider implements WhatsAppProvider {
  readonly nome = 'baileys';
  private socket: BaileysSocket | null = null;
  private handler: ((msg: MensagemRecebida) => void | Promise<void>) | null = null;
  private ok = false;
  private reconexoes = 0;

  constructor(private readonly cfg: Config) {}

  get pronto(): boolean {
    return this.ok;
  }

  async iniciar(): Promise<void> {
    if (process.env.WHATSAPP_ACEITO_RISCO !== 'sim') {
      throw new Error(
        'o provedor Baileys usa o seu número pessoal por engenharia reversa e pode levar a ' +
          'banimento do número pela Meta. Para assumir esse risco conscientemente, defina ' +
          'WHATSAPP_ACEITO_RISCO=sim. Recomendado: use WHATSAPP_PROVIDER=cloud.',
      );
    }

    let baileys: Record<string, unknown>;
    try {
      // Especificador em variável de propósito: a biblioteca é opcional e não
      // está instalada, então o compilador não deve tentar resolvê-la.
      const modulo = '@whiskeysockets/baileys';
      baileys = (await import(modulo)) as unknown as Record<string, unknown>;
    } catch {
      throw new Error(
        'a biblioteca não está instalada. Rode: npm install @whiskeysockets/baileys',
      );
    }

    const makeSocket = (baileys.default ?? baileys.makeWASocket) as (
      opts: Record<string, unknown>,
    ) => BaileysSocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState as (
      pasta: string,
    ) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;

    const pastaSessao = paths(this.cfg).whatsappSession;
    fs.mkdirSync(pastaSessao, { recursive: true, mode: 0o700 });

    const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);

    const socket = makeSocket({
      auth: state,
      printQRInTerminal: true,
      markOnlineOnConnect: false, // não rouba as notificações do seu celular
      syncFullHistory: false,
      browser: ['Gideão', 'Chrome', '1.0.0'],
    });

    socket.ev.on('creds.update', () => {
      void saveCreds();
    });

    socket.ev.on('connection.update', (dados) => {
      const u = dados as { connection?: string; lastDisconnect?: { error?: { message?: string } }; qr?: string };
      if (u.qr) {
        log.info('leia o QR que apareceu no terminal com o WhatsApp do seu celular');
      }
      if (u.connection === 'open') {
        this.ok = true;
        this.reconexoes = 0;
        log.info('conectado ao WhatsApp pelo número pessoal');
      }
      if (u.connection === 'close') {
        this.ok = false;
        const motivo = u.lastDisconnect?.error?.message ?? 'desconhecido';
        log.warn('conexão caiu', { motivo });
        // Recuo exponencial com teto: reconectar em laço apertado é o caminho
        // mais rápido para a Meta tratar o número como abusivo.
        if (this.reconexoes < 6) {
          const espera = Math.min(60_000, 2000 * 2 ** this.reconexoes++);
          setTimeout(() => void this.iniciar().catch(() => {}), espera);
        } else {
          log.error('desisti de reconectar ao WhatsApp — reinicie o Gideão para tentar de novo');
        }
      }
    });

    socket.ev.on('messages.upsert', (dados) => {
      const u = dados as {
        type?: string;
        messages?: Array<{
          key: { remoteJid?: string; fromMe?: boolean; id?: string };
          message?: { conversation?: string; extendedTextMessage?: { text?: string } };
          messageTimestamp?: number;
          pushName?: string;
        }>;
      };
      if (u.type !== 'notify') return;

      for (const m of u.messages ?? []) {
        if (m.key.fromMe) continue;
        const jid = m.key.remoteJid ?? '';
        if (jid.endsWith('@g.us')) continue; // grupos ficam de fora, sempre
        const texto = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
        if (!texto.trim()) continue;

        void this.handler?.({
          de: jid.split('@')[0] ?? '',
          texto,
          id: m.key.id ?? `${Date.now()}`,
          em: Number(m.messageTimestamp) * 1000 || Date.now(),
          tipo: 'texto',
        });
      }
    });

    this.socket = socket;
  }

  async parar(): Promise<void> {
    try {
      this.socket?.end();
    } catch (err) {
      log.warn('erro ao encerrar', { erro: describeError(err) });
    }
    this.socket = null;
    this.ok = false;
  }

  aoReceber(handler: (msg: MensagemRecebida) => void | Promise<void>): void {
    this.handler = handler;
  }

  async enviar(para: string, texto: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp não está conectado');
    await this.socket.sendMessage(`${para}@s.whatsapp.net`, { text: texto });
  }
}
