/** Tipos de memória. A distinção importa: cada um é recuperado e envelhece diferente. */
export type MemoryKind =
  /** Fato estável sobre o mundo ou sobre o dono. "Atende na comarca de Macapá." */
  | 'fato'
  /** Como o dono gosta que as coisas sejam feitas. "Prefere resposta curta primeiro." */
  | 'preferencia'
  /** Pessoa: cliente, colega, parte contrária, família. */
  | 'pessoa'
  /** Processo judicial e seu estado. */
  | 'processo'
  /** Procedimento aprendido: o passo a passo de uma tarefa que já foi feita antes. */
  | 'procedimento'
  /** Algo que aconteceu, com data. Resumo de conversa, reunião, decisão. */
  | 'evento'
  /** Conclusão que o próprio Gideão tirou observando padrões. */
  | 'insight'
  /** Retrato consolidado do dono — reescrito pela consolidação. */
  | 'perfil'
  /** Nota de que existe credencial no cofre para tal serviço (sem o valor). */
  | 'credencial';

export const MEMORY_KINDS: MemoryKind[] = [
  'fato',
  'preferencia',
  'pessoa',
  'processo',
  'procedimento',
  'evento',
  'insight',
  'perfil',
  'credencial',
];

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** Do que trata, em poucas palavras. Serve de chave de deduplicação. */
  subject: string;
  content: string;
  /** 0..1 — o quanto vale a pena lembrar disso. */
  importance: number;
  /** 0..1 — o quanto o Gideão confia nessa informação. */
  confidence: number;
  source: string;
  conversationId?: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
  useCount: number;
  pinned: boolean;
  expiresAt?: number | null;
  supersededBy?: string | null;
}

export interface MemoryInput {
  kind: MemoryKind;
  subject: string;
  content: string;
  importance?: number;
  confidence?: number;
  source?: string;
  conversationId?: string | null;
  pinned?: boolean;
  /** Validade em dias — para coisas que envelhecem ("está de férias até dia 20"). */
  ttlDays?: number;
  /**
   * Pula a deduplicação da gravação. Usado ao restaurar um backup, onde os
   * registros já vêm resolvidos e fundir na entrada apagaria histórico.
   */
  skipDedup?: boolean;
}

export interface ScoredMemory extends Memory {
  score: number;
  /** De onde veio a pontuação — útil para depurar a recuperação. */
  why: { semantic: number; lexical: number; recency: number; importance: number };
}

/** Meia-vida da recência: uma memória de 30 dias vale metade em "frescor". */
export const RECENCY_HALFLIFE_MS = 30 * 86_400_000;
