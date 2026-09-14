/**
 * Provedor oficial: WhatsApp Cloud API da Meta.
 *
 * As mensagens chegam por webhook, não por conexão persistente — então este
 * módulo pendura duas rotas no servidor que já existe:
 *
 *   GET  /webhook/whatsapp  → verificação inicial (hub.challenge)
 *   POST /webhook/whatsapp  → entrega das mensagens
 *
 * O POST só é aceito com assinatura `X-Hub-Signature-256` válida. Sem isso,
 * qualquer um que descobrisse a URL poderia mandar mensagens fingindo ser você
 * — e a Íris tem acesso ao seu computador.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';
import type { MensagemRecebida, WhatsAppProvider } from './provider.js';

const log = createLogger('whatsapp:cloud');

interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string };
  image?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: CloudMessage[] };
    }>;
  }>;
}

export class CloudApiProvider implements WhatsAppProvider {
  readonly nome = 'cloud';
  private handler: ((msg: MensagemRecebida) => void | Promise<void>) | null = null;
  private vistas = new Set<string>();
  private ok = false;

  constructor(
    private readonly cfg: Config,
    private readonly app: FastifyInstance,
  ) {}

  get pronto(): boolean {
    return this.ok;
  }

  async iniciar(): Promise<void> {
    const { phoneNumberId, accessToken, verifyToken } = this.cfg.whatsapp;
    if (!phoneNumberId || !accessToken) {
      throw new Error(
        'WhatsApp Cloud API sem credenciais — preencha WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN',
      );
    }
    if (!verifyToken) {
      throw new Error('defina WHATSAPP_VERIFY_TOKEN (você escolhe o valor; a Meta só confere)');
    }
    if (!this.cfg.whatsapp.appSecret) {
      log.warn(
        'WHATSAPP_APP_SECRET vazio: as mensagens não terão assinatura conferida. ' +
          'Preencha antes de expor o webhook na internet.',
      );
    }

    this.registrarRotas();
    this.ok = true;
    log.info('webhook do WhatsApp registrado em /webhook/whatsapp');
  }

  async parar(): Promise<void> {
    this.ok = false;
  }

  aoReceber(handler: (msg: MensagemRecebida) => void | Promise<void>): void {
    this.handler = handler;
  }

  async enviar(para: string, texto: string): Promise<void> {
    const { graphVersion, phoneNumberId, accessToken } = this.cfg.whatsapp;
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: para,
        type: 'text',
        text: { preview_url: false, body: texto },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new Error(`Cloud API respondeu ${res.status}: ${corpo.slice(0, 300)}`);
    }
  }

  // ── rotas ──────────────────────────────────────────────────────────────────

  private registrarRotas(): void {
    // Verificação: a Meta chama uma vez ao cadastrar o webhook.
    this.app.get('/webhook/whatsapp', async (req, reply) => {
      const q = req.query as Record<string, string>;
      if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === this.cfg.whatsapp.verifyToken) {
        log.info('webhook verificado pela Meta');
        return reply.code(200).send(q['hub.challenge']);
      }
      log.warn('tentativa de verificação de webhook com token errado');
      return reply.code(403).send('forbidden');
    });

    this.app.post('/webhook/whatsapp', async (req, reply) => {
      // O corpo cru vem do parser registrado em HttpChannel.prepare(): a Meta
      // assina os bytes exatos que enviou, e um JSON reserializado não bate.
      const assinatura = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
      const cru = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);

      if (this.cfg.whatsapp.appSecret && !this.assinaturaValida(cru, assinatura)) {
        log.warn('webhook recusado: assinatura inválida');
        return reply.code(401).send('assinatura inválida');
      }

      // Responder rápido evita reentrega pela Meta; o processamento segue solto.
      void reply.code(200).send('ok');
      void this.processar(req.body as WebhookPayload);
      return reply;
    });
  }

  private assinaturaValida(corpo: string, cabecalho: string): boolean {
    if (!cabecalho.startsWith('sha256=')) return false;
    const esperado = createHmac('sha256', this.cfg.whatsapp.appSecret)
      .update(corpo, 'utf8')
      .digest('hex');
    const recebido = cabecalho.slice(7);
    if (recebido.length !== esperado.length) return false;
    return timingSafeEqual(Buffer.from(recebido, 'hex'), Buffer.from(esperado, 'hex'));
  }

  private async processar(payload: WebhookPayload): Promise<void> {
    try {
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          for (const msg of change.value?.messages ?? []) {
            // A Meta reentrega mensagens quando não recebe 200 a tempo.
            if (this.vistas.has(msg.id)) continue;
            this.vistas.add(msg.id);
            if (this.vistas.size > 500) {
              this.vistas = new Set([...this.vistas].slice(-200));
            }

            const recebida = converter(msg);
            if (recebida) await this.handler?.(recebida);
          }
        }
      }
    } catch (err) {
      log.error('falha ao processar webhook', { erro: describeError(err) });
    }
  }
}

function converter(msg: CloudMessage): MensagemRecebida | null {
  const base = {
    de: msg.from,
    id: msg.id,
    em: Number(msg.timestamp) * 1000 || Date.now(),
  };

  switch (msg.type) {
    case 'text':
      return { ...base, texto: msg.text?.body ?? '', tipo: 'texto' };
    case 'image':
      return {
        ...base,
        texto: msg.image?.caption
          ? `[imagem enviada] ${msg.image.caption}`
          : '[imagem enviada sem legenda — não consigo ver imagens pelo WhatsApp ainda]',
        tipo: 'imagem',
      };
    case 'audio':
      return {
        ...base,
        texto: '[áudio enviado — a transcrição de áudio do WhatsApp ainda não está ligada]',
        tipo: 'audio',
      };
    case 'document':
      return {
        ...base,
        texto: `[documento enviado: ${msg.document?.filename ?? 'sem nome'}] ${msg.document?.caption ?? ''}`.trim(),
        tipo: 'documento',
      };
    default:
      return null;
  }
}
