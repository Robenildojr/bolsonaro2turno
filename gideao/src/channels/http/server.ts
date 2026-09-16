/**
 * Servidor local: serve a interface do orbe e mantém o WebSocket por onde os
 * tokens chegam em tempo real.
 *
 * Escuta em 127.0.0.1 por padrão e exige token de acesso. Não é "segurança por
 * obscuridade": sem o token, nem a página nem o WebSocket respondem — e como o
 * processo tem acesso ao seu computador, ao seu e-mail e às suas credenciais,
 * abrir isso na rede sem um túnel autenticado seria imprudente.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { loadConfig, type Config } from '../../config.js';
import { bus } from '../../core/events/bus.js';
import { getAgent } from '../../core/agent/agent.js';
import { getMemory } from '../../core/memory/index.js';
import { getBroker } from '../../core/permissions/broker.js';
import { getAudit } from '../../core/permissions/audit.js';
import { getStore } from '../../core/db/database.js';
import { constantTimeEqual } from '../../core/crypto/cipher.js';
import { guardar, metadados, tiposAceitos, type Anexo } from '../../core/agent/attachments.js';
import { createLogger, describeError } from '../../util/logger.js';
import type { Decision } from '../../core/permissions/capabilities.js';
import { aplicarAjustes, lerAjustes } from '../../core/settings/ajustes.js';
import { recarregarNoVivo } from '../../core/settings/aovivo.js';

const log = createLogger('servidor');
const here = path.dirname(fileURLToPath(import.meta.url));

/** Mensagens que o navegador manda. */
type ClientMessage =
  | { type: 'mensagem'; texto: string; conversaId?: string; anexos?: string[] }
  | { type: 'interromper' }
  | { type: 'permissao'; id: string; decisao: Decision }
  | { type: 'historico'; conversaId?: string }
  | { type: 'ping' };

export class HttpChannel {
  private app: FastifyInstance;
  private clients = new Set<WebSocket>();
  private conversationId: string | null = null;

  constructor(private cfg: Config = loadConfig()) {
    this.app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  }

  /** Expõe a instância para outros canais pendurarem rotas (webhook do WhatsApp). */
  get fastify(): FastifyInstance {
    return this.app;
  }

  /**
   * Registra plugins e rotas, sem abrir a porta.
   *
   * Separado de `listen` porque o Fastify não aceita rotas novas depois que o
   * servidor está no ar — e o webhook do WhatsApp precisa entrar aqui, entre
   * o preparo e a escuta.
   */
  async prepare(): Promise<FastifyInstance> {
    await this.app.register(fastifyWebsocket);

    /*
     * Guarda o corpo cru de cada JSON. A assinatura do webhook da Meta é
     * calculada sobre os bytes exatos que ela enviou; um JSON reserializado
     * não bate, e a verificação falharia sempre.
     */
    this.app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (req, body, done) => {
        (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
        try {
          done(null, body === '' ? {} : JSON.parse(body as string));
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    // A raiz do projeto sobe um nível a partir de dist/ ou de src/.
    const webRoot = path.resolve(here, '../../../web');
    await this.app.register(fastifyStatic, { root: webRoot, prefix: '/', index: false });

    this.registerRoutes(webRoot);
    this.bridgeBusToClients();
    return this.app;
  }

  /** Abre a porta. Depois disto, nenhuma rota nova é aceita. */
  async listen(): Promise<string> {
    const address = await this.app.listen({ host: this.cfg.server.host, port: this.cfg.server.port });
    const url = `${address}/?token=${this.cfg.server.accessToken ?? ''}`;
    log.info('interface no ar', { endereco: address });
    return url;
  }

  /** Preparo + escuta, para quem não precisa pendurar nada no meio. */
  async start(): Promise<string> {
    await this.prepare();
    return this.listen();
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) {
      try {
        socket.close();
      } catch {
        /* já fechado */
      }
    }
    this.clients.clear();
    await this.app.close();
  }

  // ── rotas ──────────────────────────────────────────────────────────────────

  private registerRoutes(webRoot: string): void {
    const auth = (req: FastifyRequest, reply: FastifyReply): boolean => {
      if (!this.checkToken(tokenOf(req))) {
        reply.code(401).send({ erro: 'token de acesso inválido' });
        return false;
      }
      return true;
    };

    this.app.get('/', async (req, reply) => {
      if (!this.checkToken(tokenOf(req))) {
        return reply.code(401).type('text/html; charset=utf-8').send(TOKEN_PAGE);
      }
      return reply.sendFile('index.html', webRoot);
    });

    this.app.get('/api/estado', async (req, reply) => {
      if (!auth(req, reply)) return;
      const memory = getMemory();
      return {
        assistente: this.cfg.assistantName,
        dono: this.cfg.ownerName,
        conversaId: this.currentConversation(),
        ocupada: getAgent().busy,
        memorias: memory.stats(),
        autorizacoes: getBroker().list().length,
        pendentes: getBroker().listPending(),
        observador: this.cfg.observer.enabled,
        banco: getStore().stats(),
        // Relidos do disco: a engrenagem pode ter mudado isso desde o arranque.
        voz: loadConfig().voice,
        tela: loadConfig().ui,
      };
    });

    this.app.get('/api/historico', async (req, reply) => {
      if (!auth(req, reply)) return;
      const query = req.query as { conversaId?: string; limite?: string };
      const conversationId = query.conversaId ?? this.currentConversation();
      const limit = Math.min(200, Number(query.limite) || 60);
      const mensagens = getMemory()
        .conversations.recent(conversationId, limit)
        .filter((m) => m.content.trim())
        .map((m) => ({ papel: m.role, conteudo: m.content, em: m.createdAt }));
      return { conversaId: conversationId, mensagens };
    });

    this.app.get('/api/conversas', async (req, reply) => {
      if (!auth(req, reply)) return;
      return getMemory()
        .conversations.list(40)
        .map((c) => ({
          id: c.id,
          canal: c.channel,
          titulo: c.title || '(sem título)',
          mensagens: c.messageCount,
          atualizada: c.updatedAt,
        }));
    });

    this.app.get('/api/auditoria', async (req, reply) => {
      if (!auth(req, reply)) return;
      const query = req.query as { limite?: string };
      return getAudit().list({ limit: Math.min(300, Number(query.limite) || 60) });
    });

    // ── engrenagem ────────────────────────────────────────────────────────

    this.app.get('/api/ajustes', async (req, reply) => {
      if (!auth(req, reply)) return;
      return { ajustes: lerAjustes(loadConfig({ reload: true })) };
    });

    /**
     * Grava ajustes. O corpo é `{ "voice.tom": 0.9, "ui.matiz": 200 }`.
     *
     * Devolve o que entrou E o que foi recusado, com motivo: um campo que o
     * dono mexeu e voltou sozinho, sem explicação, é o pior tipo de painel.
     */
    this.app.patch('/api/ajustes', async (req, reply) => {
      if (!auth(req, reply)) return;
      const corpo = req.body as Record<string, unknown> | undefined;
      if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
        return reply.code(400).send({ erro: 'mande um objeto com chave e valor' });
      }
      const resultado = aplicarAjustes(corpo, 'interface');
      if (resultado.aplicados.length) {
        this.cfg = await recarregarNoVivo();
        getAudit().record({
          action: 'ajuste.alterado',
          detail: { origem: 'engrenagem', mudancas: resultado.aplicados.map((a) => a.chave) },
        });
        this.broadcast({ type: 'ajustes', ajustes: lerAjustes(this.cfg) });
      }
      return resultado;
    });

    this.app.get('/api/autorizacoes', async (req, reply) => {
      if (!auth(req, reply)) return;
      return { autorizacoes: getBroker().list() };
    });

    this.app.delete('/api/autorizacao/:id', async (req, reply) => {
      if (!auth(req, reply)) return;
      const { id } = req.params as { id: string };
      return { ok: getBroker().revoke(id) };
    });

    this.app.post('/api/permissao', async (req, reply) => {
      if (!auth(req, reply)) return;
      const body = req.body as { id?: string; decisao?: Decision };
      if (!body?.id || !body.decisao) return reply.code(400).send({ erro: 'informe id e decisao' });
      const ok = getBroker().resolve(body.id, body.decisao);
      return { ok };
    });

    /** Envio sem WebSocket — útil para script, atalho de teclado, integração. */
    this.app.post('/api/mensagem', async (req, reply) => {
      if (!auth(req, reply)) return;
      const body = req.body as { texto?: string; conversaId?: string };
      if (!body?.texto?.trim()) return reply.code(400).send({ erro: 'texto vazio' });
      const result = await getAgent().run({
        conversationId: body.conversaId ?? this.currentConversation(),
        channel: 'web',
        text: body.texto,
      });
      return { resposta: result.text, conversaId: result.conversationId };
    });

    /**
     * Recebe um anexo (foto de documento, PDF, texto) em base64.
     *
     * Chega por JSON e não por multipart de propósito: o corpo já passa pelo
     * mesmo parser que guarda o corpo cru do webhook, e o limite de 16 MB do
     * servidor cobre com folga os limites de anexo da própria API.
     */
    this.app.post('/api/anexo', async (req, reply) => {
      if (!auth(req, reply)) return;
      const body = req.body as { nome?: string; mime?: string; base64?: string };
      if (!body?.base64 || !body.nome) {
        return reply.code(400).send({ erro: `informe nome e base64. Aceito: ${tiposAceitos()}` });
      }

      try {
        const anexo = await guardar(Buffer.from(body.base64, 'base64'), {
          nome: body.nome,
          mime: body.mime ?? '',
        });
        return anexo;
      } catch (err) {
        return reply.code(400).send({ erro: describeError(err) });
      }
    });

    this.app.get('/saude', async () => ({ ok: true, em: Date.now() }));

    this.app.get('/ws', { websocket: true }, (socket, req) => {
      if (!this.checkToken(tokenOf(req))) {
        socket.send(JSON.stringify({ type: 'erro', mensagem: 'token de acesso inválido' }));
        socket.close();
        return;
      }
      this.handleSocket(socket);
    });
  }

  // ── websocket ──────────────────────────────────────────────────────────────

  private handleSocket(socket: WebSocket): void {
    this.clients.add(socket);
    log.info('cliente conectado', { total: this.clients.size });

    this.send(socket, {
      type: 'ola',
      assistente: this.cfg.assistantName,
      conversaId: this.currentConversation(),
      observador: this.cfg.observer.enabled,
      // A aba aplica isto ao abrir: voz, cor do orbe e legenda já vêm certas
      // na primeira pintura, sem piscar o padrão antes.
      voz: this.cfg.voice,
      tela: this.cfg.ui,
    });

    // Um pedido de autorização que ficou pendente enquanto a aba estava fechada
    // precisa reaparecer, senão o dono fica esperando uma pergunta que sumiu.
    for (const pending of getBroker().listPending()) {
      this.send(socket, { type: 'permissao', ...pending });
    }

    socket.on('message', (raw: Buffer) => {
      void this.onClientMessage(socket, raw);
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      log.info('cliente desconectado', { total: this.clients.size });
    });

    socket.on('error', (err: Error) => {
      log.warn('erro no websocket', { erro: err.message });
      this.clients.delete(socket);
    });
  }

  private async onClientMessage(socket: WebSocket, raw: Buffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString('utf8')) as ClientMessage;
    } catch {
      return this.send(socket, { type: 'erro', mensagem: 'mensagem malformada' });
    }

    try {
      switch (msg.type) {
        case 'ping':
          return this.send(socket, { type: 'pong' });

        case 'permissao':
          getBroker().resolve(msg.id, msg.decisao);
          return;

        case 'interromper': {
          const parou = getAgent().interrupt(this.currentConversation());
          return this.send(socket, { type: 'interrompido', ok: parou });
        }

        case 'historico': {
          const conversationId = msg.conversaId ?? this.currentConversation();
          const mensagens = getMemory()
            .conversations.recent(conversationId, 60)
            .filter((m) => m.content.trim())
            .map((m) => ({ papel: m.role, conteudo: m.content, em: m.createdAt }));
          return this.send(socket, { type: 'historico', conversaId: conversationId, mensagens });
        }

        case 'mensagem': {
          const texto = (msg.texto ?? '').trim();
          const anexos = (msg.anexos ?? [])
            .map((id) => metadados(id))
            .filter((a): a is Anexo => a !== null);
          // Anexo sozinho é mensagem válida: a foto já diz o que ele quer.
          if (!texto && anexos.length === 0) return;

          const conversationId = msg.conversaId ?? this.currentConversation();
          this.broadcast({
            type: 'mensagem',
            papel: 'user',
            conteudo: texto || anexos.map((a) => `[${a.tipo}: ${a.nome}]`).join(' '),
            em: Date.now(),
          });
          const result = await getAgent().run({
            conversationId,
            channel: 'web',
            text: texto || `Veja o que eu anexei: ${anexos.map((a) => a.nome).join(', ')}.`,
            ...(anexos.length ? { attachments: anexos } : {}),
          });
          this.broadcast({
            type: 'fim',
            conversaId: result.conversationId,
            interrompido: result.interrupted,
            ferramentas: result.toolCalls,
          });
          return;
        }

        default:
          return;
      }
    } catch (err) {
      log.error('falha ao tratar mensagem do cliente', { erro: describeError(err) });
      this.send(socket, { type: 'erro', mensagem: describeError(err) });
      this.broadcast({ type: 'estado', estado: 'idle' });
    }
  }

  // ── ponte com o barramento ─────────────────────────────────────────────────

  private bridgeBusToClients(): void {
    bus.on('agent:delta', (e) => this.broadcast({ type: 'delta', texto: e.text }));
    bus.on('agent:thinking', (e) => this.broadcast({ type: 'pensando', texto: e.text }));
    bus.on('agent:state', (e) =>
      this.broadcast({ type: 'estado', estado: e.state, detalhe: e.detail ?? null }),
    );
    bus.on('agent:message', (e) => {
      if (e.role === 'assistant') {
        this.broadcast({ type: 'mensagem', papel: 'assistant', conteudo: e.content, em: Date.now() });
      }
    });
    bus.on('tool:start', (e) =>
      this.broadcast({ type: 'ferramenta', fase: 'inicio', nome: e.tool, resumo: e.summary, id: e.id }),
    );
    bus.on('tool:end', (e) =>
      this.broadcast({ type: 'ferramenta', fase: 'fim', nome: e.tool, ok: e.ok, resumo: e.summary, id: e.id }),
    );
    bus.on('permission:request', (e) => this.broadcast({ type: 'permissao', ...e }));
    bus.on('permission:resolved', (e) => this.broadcast({ type: 'permissao_resolvida', ...e }));
    bus.on('notify', (e) => this.broadcast({ type: 'notificacao', ...e }));
    bus.on('observer:state', (e) => this.broadcast({ type: 'observador', ...e }));
    bus.on('memory:learned', (e) => this.broadcast({ type: 'aprendi', ...e }));
  }

  private broadcast(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    for (const socket of this.clients) {
      if (socket.readyState === 1) {
        try {
          socket.send(data);
        } catch {
          this.clients.delete(socket);
        }
      }
    }
  }

  private send(socket: WebSocket, payload: Record<string, unknown>): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(payload));
  }

  // ── auxiliares ─────────────────────────────────────────────────────────────

  private currentConversation(): string {
    if (!this.conversationId) {
      this.conversationId = getMemory().conversations.current('web').id;
    }
    return this.conversationId;
  }

  /** Comparação em tempo constante — não deixa o token vazar por timing. */
  private checkToken(provided: string | null): boolean {
    const expected = this.cfg.server.accessToken;
    if (!expected) return true; // sem token configurado, o servidor fica aberto localmente
    if (!provided) return false;
    return constantTimeEqual(provided, expected);
  }

  get connectedClients(): number {
    return this.clients.size;
  }
}

function tokenOf(req: FastifyRequest | { url?: string; headers: Record<string, unknown> }): string | null {
  const headers = req.headers as Record<string, string | undefined>;
  const authorization = headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  if (headers['x-gideao-token']) return headers['x-gideao-token']!;

  const url = (req as { url?: string }).url;
  if (url) {
    const q = url.indexOf('?');
    if (q >= 0) {
      const token = new URLSearchParams(url.slice(q + 1)).get('token');
      if (token) return token;
    }
  }
  const cookie = headers.cookie;
  if (cookie) {
    const match = /(?:^|;\s*)gideao_token=([^;]+)/.exec(cookie);
    if (match) return decodeURIComponent(match[1]!);
  }
  return null;
}

const TOKEN_PAGE = `<!doctype html><meta charset="utf-8">
<title>Gideão — acesso</title>
<style>
  body{background:#07070a;color:#e8e8ee;font:16px/1.6 system-ui,sans-serif;
       display:grid;place-items:center;height:100vh;margin:0;text-align:center}
  div{max-width:38rem;padding:2rem}
  code{background:#17171f;padding:.2em .45em;border-radius:.3em;font-size:.9em}
</style>
<div>
  <h1>Acesso negado</h1>
  <p>Esta página exige o token de acesso local.</p>
  <p>Abra o endereço que apareceu no terminal ao iniciar o Gideão, ou consulte-o com
     <code>npm run gideao -- status</code>.</p>
</div>`;

let singleton: HttpChannel | null = null;

export function initHttpChannel(cfg?: Config): HttpChannel {
  singleton = new HttpChannel(cfg);
  return singleton;
}

export function getHttpChannel(): HttpChannel | null {
  return singleton;
}
