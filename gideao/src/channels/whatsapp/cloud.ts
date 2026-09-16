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
 * — e o Gideão tem acesso ao seu computador.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { createLogger, describeError } from '../../util/logger.js';
import type { MensagemRecebida, MidiaRecebida, WhatsAppProvider } from './provider.js';

const log = createLogger('whatsapp:cloud');

interface CloudMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string };
  image?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string; mime_type?: string };
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: CloudMessage[] };
    }>;
  }>;
}

/**
 * Confere a assinatura da Meta sobre o corpo cru.
 *
 * Fora da classe para poder ser testada como função pura: este é o único ponto
 * que separa "mensagem do dono" de "mensagem de quem descobriu a URL do túnel",
 * e um controle de acesso sem teste é um controle de acesso por esperança.
 */
export function assinaturaValida(corpo: string, cabecalho: string, appSecret: string): boolean {
  // Sem segredo configurado não há o que conferir — e passar adiante nesse caso
  // seria aceitar qualquer corpo. `iniciar()` já recusa subir assim; isto é a
  // segunda tranca, para o caso de alguém instanciar o provedor por outro caminho.
  if (!appSecret) return false;
  if (!cabecalho.startsWith('sha256=')) return false;

  const recebido = cabecalho.slice(7);
  // Sem esta checagem, um cabeçalho não-hexadecimal faria o Buffer.from vir
  // curto e o timingSafeEqual lançar — erro 500 em vez de 401.
  if (!/^[0-9a-f]{64}$/i.test(recebido)) return false;

  const esperado = createHmac('sha256', appSecret).update(corpo, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(recebido, 'hex'), Buffer.from(esperado, 'hex'));
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
    /*
     * Sem segredo do app não há webhook.
     *
     * Antes isto era um aviso e a verificação ficava condicional — o que
     * significa que a instalação subia funcionando e qualquer um que achasse a
     * URL podia forjar uma mensagem "vinda do dono" e comandar o Gideão: shell,
     * arquivos, cofre. O webhook precisa ser alcançável pela internet para a
     * Cloud API funcionar, então o segredo é o único controle que existe aqui.
     * Falhar no arranque é bem melhor que rodar aberto.
     */
    if (!this.cfg.whatsapp.appSecret) {
      throw new Error(
        'WHATSAPP_APP_SECRET está vazio. Sem ele eu não consigo distinguir uma mensagem da Meta ' +
          'de uma forjada por quem descobrir a URL do webhook — e quem forja passa a comandar a ' +
          'Gideão no seu lugar. Pegue a chave secreta em Configurações do app → Básico, no painel ' +
          'da Meta, e ponha em WHATSAPP_APP_SECRET.',
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

  /**
   * Baixa uma mídia em duas etapas, como a Graph API exige: primeiro o
   * endereço temporário, depois os bytes — os dois com o mesmo token.
   */
  async baixarMidia(midia: MidiaRecebida): Promise<Buffer | null> {
    const { graphVersion, accessToken } = this.cfg.whatsapp;

    const meta = await fetch(`https://graph.facebook.com/${graphVersion}/${midia.id}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!meta.ok) {
      log.warn('não consegui obter o endereço da mídia', { status: meta.status });
      return null;
    }

    const { url, file_size: tamanho } = (await meta.json()) as { url?: string; file_size?: number };
    if (!url) return null;
    if (tamanho && tamanho > 30 * 1024 * 1024) {
      log.warn('mídia grande demais', { bytes: tamanho });
      return null;
    }

    // O endereço devolvido também exige o token — não é um link público.
    const bytes = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!bytes.ok) {
      log.warn('não consegui baixar a mídia', { status: bytes.status });
      return null;
    }
    return Buffer.from(await bytes.arrayBuffer());
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

      // Incondicional: sem assinatura válida, não passa.
      if (!this.assinaturaValida(cru, assinatura)) {
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
    return assinaturaValida(corpo, cabecalho, this.cfg.whatsapp.appSecret);
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
        texto: msg.image?.caption ?? '',
        tipo: 'imagem',
        ...(msg.image?.id
          ? { midia: { id: msg.image.id, mime: 'image/jpeg', nome: `foto-${base.id.slice(-8)}.jpg` } }
          : {}),
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
        texto: msg.document?.caption ?? '',
        tipo: 'documento',
        ...(msg.document?.id
          ? {
              midia: {
                id: msg.document.id,
                mime: msg.document.mime_type ?? 'application/pdf',
                nome: msg.document.filename ?? `documento-${base.id.slice(-8)}.pdf`,
              },
            }
          : {}),
      };
    default:
      return null;
  }
}
