/**
 * Barramento de eventos interno. Conecta o agente aos canais (web, WhatsApp),
 * ao broker de permissões, ao scheduler e ao observador — sem acoplar módulos.
 */
import { EventEmitter } from 'node:events';

export interface GideaoEventos {
  /** Token de texto vindo do modelo. */
  'agent:delta': { conversationId: string; text: string };
  /** Resumo do raciocínio (quando habilitado). */
  'agent:thinking': { conversationId: string; text: string };
  /** Mudança de estado visual do orbe. */
  'agent:state': {
    conversationId: string;
    state: 'idle' | 'listening' | 'thinking' | 'responding' | 'working' | 'error';
    detail?: string;
  };
  /** Turno completo terminado. */
  'agent:message': {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    channel: string;
  };
  /** Ferramenta iniciada/terminada — alimenta a UI e a auditoria. */
  'tool:start': { conversationId: string; tool: string; summary: string; id: string };
  'tool:end': { conversationId: string; tool: string; ok: boolean; summary: string; id: string };
  /** Pedido de autorização aguardando decisão do dono. */
  'permission:request': {
    id: string;
    capability: string;
    scope: string;
    risk: string;
    reason: string;
    details: Record<string, unknown>;
    expiresAt: number;
  };
  'permission:resolved': { id: string; decision: string };
  /** Notificação proativa (lembrete, audiência, e-mail importante, movimentação). */
  notify: {
    id: string;
    title: string;
    body: string;
    kind: string;
    urgency: 'low' | 'normal' | 'high';
    channels?: string[];
  };
  /** Observador ligou/desligou — a UI mostra o indicador. */
  'observer:state': { active: boolean; sources: string[] };
  /** Algo aprendido foi gravado na memória. */
  'memory:learned': { count: number; summary: string };
}

type Handler<K extends keyof GideaoEventos> = (payload: GideaoEventos[K]) => void | Promise<void>;

class TypedBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof GideaoEventos>(event: K, handler: Handler<K>): () => void {
    const wrapped = (payload: GideaoEventos[K]) => {
      void Promise.resolve(handler(payload)).catch(() => {});
    };
    this.emitter.on(event as string, wrapped);
    return () => this.emitter.off(event as string, wrapped);
  }

  once<K extends keyof GideaoEventos>(event: K, handler: Handler<K>): void {
    this.emitter.once(event as string, (p: GideaoEventos[K]) => {
      void Promise.resolve(handler(p)).catch(() => {});
    });
  }

  emit<K extends keyof GideaoEventos>(event: K, payload: GideaoEventos[K]): void {
    this.emitter.emit(event as string, payload);
  }
}

export const bus = new TypedBus();
