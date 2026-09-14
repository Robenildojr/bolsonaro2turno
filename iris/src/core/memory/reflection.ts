/**
 * Reflexão — o passo que transforma conversa em memória.
 *
 * Roda em segundo plano a cada N turnos. Lê o trecho recente do diálogo, olha
 * o que já sabia sobre aquilo e decide: o que é novo, o que mudou, o que estava
 * errado. Sem esse passo o sistema só teria transcrição, e transcrição não é
 * memória — é arquivo morto.
 */
import { extractStructured } from '../llm.js';
import { createLogger } from '../../util/logger.js';
import { bus } from '../events/bus.js';
import type { MemoryStore } from './store.js';
import type { Retriever } from './retrieval.js';
import type { StoredMessage } from './conversations.js';
import { MEMORY_KINDS, type MemoryKind } from './types.js';

const log = createLogger('reflexao');

interface ExtractedMemory {
  tipo: string;
  assunto: string;
  conteudo: string;
  importancia: number;
  confianca: number;
  validade_dias: number;
}

interface ReflectionResult {
  memorias: ExtractedMemory[];
  correcoes: Array<{ id_memoria: string; novo_conteudo: string; motivo: string }>;
  titulo_conversa: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['memorias', 'correcoes', 'titulo_conversa'],
  properties: {
    memorias: {
      type: 'array',
      description: 'Aprendizados novos. Lista vazia se a conversa não ensinou nada duradouro.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tipo', 'assunto', 'conteudo', 'importancia', 'confianca', 'validade_dias'],
        properties: {
          tipo: {
            type: 'string',
            enum: MEMORY_KINDS.filter((k) => k !== 'perfil'),
            description:
              'fato (verdade estável) · preferencia (como ele gosta) · pessoa · processo · procedimento (passo a passo aprendido) · evento (aconteceu, tem data) · insight (padrão percebido) · credencial (existe credencial no cofre para X)',
          },
          assunto: {
            type: 'string',
            description: 'Do que trata, em até 8 palavras. Serve de chave — seja consistente.',
          },
          conteudo: {
            type: 'string',
            description:
              'A informação completa e autossuficiente, escrita para ser lida daqui a um ano sem o contexto da conversa. Inclua nomes, números e datas.',
          },
          importancia: { type: 'number', description: '0 a 1. Trivialidade 0.2; algo que muda decisões 0.9.' },
          confianca: { type: 'number', description: '0 a 1. Afirmado diretamente pelo dono 0.95; inferido 0.6.' },
          validade_dias: {
            type: 'integer',
            description: 'Dias até a informação vencer. 0 = não vence. Use para estados temporários.',
          },
        },
      },
    },
    correcoes: {
      type: 'array',
      description: 'Memórias existentes que a conversa mostrou estarem erradas ou desatualizadas.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id_memoria', 'novo_conteudo', 'motivo'],
        properties: {
          id_memoria: { type: 'string', description: 'O id exato mostrado na lista de memórias conhecidas.' },
          novo_conteudo: { type: 'string', description: 'A versão corrigida.' },
          motivo: { type: 'string', description: 'O que na conversa mostrou que estava errado.' },
        },
      },
    },
    titulo_conversa: {
      type: 'string',
      description: 'Título curto para esta conversa, até 6 palavras.',
    },
  },
} as const;

const SYSTEM = `Você é o processo de memória de uma assistente pessoal. Sua tarefa não é conversar: é decidir o que merece ser lembrado de um trecho de diálogo entre a assistente e o dono dela.

Critério do que guardar:
- Guarde o que continuará verdadeiro ou útil depois que a conversa acabar: fatos sobre a vida e o trabalho do dono, preferências de como ele quer as coisas, pessoas e clientes, processos, procedimentos que ele ensinou, decisões tomadas.
- Guarde também o que ele corrigiu em você. Correção é o aprendizado mais valioso que existe.
- NÃO guarde: cumprimentos, confirmações, o próprio texto das respostas da assistente, perguntas sem resposta, ou coisas que já estão na lista de memórias conhecidas sem nenhuma informação nova.

Qualidade importa mais que quantidade. Três memórias densas valem mais que quinze frouxas. Uma conversa trivial deve produzir lista vazia — isso é resposta certa, não falha.

Escreva cada memória de forma autossuficiente, em português, na terceira pessoa ("O dono prefere…", "O cliente Fulano…"). Nunca escreva "ele disse que" sem dizer quem é "ele". Nunca guarde senha, token ou número de cartão — se aparecer uma credencial, registre apenas que ela existe e para que serve, tipo "credencial".`;

export class Reflector {
  constructor(
    private readonly memories: MemoryStore,
    private readonly retriever: Retriever,
  ) {}

  /** Extrai aprendizados de um trecho de conversa. Devolve quantas memórias gravou. */
  async reflect(
    messages: StoredMessage[],
    conversationId: string,
  ): Promise<{ learned: number; title: string }> {
    const transcript = messages
      .filter((m) => m.content.trim())
      .map((m) => `${m.role === 'user' ? 'DONO' : 'ASSISTENTE'}: ${m.content.slice(0, 4000)}`)
      .join('\n\n');

    if (transcript.length < 120) return { learned: 0, title: '' };

    // Mostra o que já se sabe, para não duplicar e para permitir correções.
    const known = await this.retriever.search(transcript.slice(0, 4000), { limit: 25, diversity: 0.4 });
    const knownBlock =
      known.length > 0
        ? known.map((m) => `[${m.id}] (${m.kind}) ${m.subject}: ${m.content}`).join('\n')
        : '(nada ainda)';

    const result = await extractStructured<ReflectionResult>({
      system: SYSTEM,
      prompt: `MEMÓRIAS JÁ CONHECIDAS SOBRE ESTE ASSUNTO:\n${knownBlock}\n\n---\n\nTRECHO DE CONVERSA A ANALISAR:\n${transcript}`,
      toolName: 'registrar_aprendizado',
      toolDescription: 'Registra o que deve ser lembrado deste trecho de conversa.',
      schema: SCHEMA as unknown as Record<string, unknown>,
      effort: 'medium',
      maxTokens: 8000,
    });

    if (!result) return { learned: 0, title: '' };

    let learned = 0;
    for (const item of result.memorias ?? []) {
      const kind = normalizeKind(item.tipo);
      if (!kind) continue;
      if (!item.conteudo?.trim()) continue;
      try {
        await this.memories.remember({
          kind,
          subject: item.assunto ?? '',
          content: item.conteudo,
          importance: item.importancia,
          confidence: item.confianca,
          source: 'reflexão',
          conversationId,
          ...(item.validade_dias > 0 ? { ttlDays: item.validade_dias } : {}),
        });
        learned++;
      } catch (err) {
        log.warn('não consegui gravar uma memória extraída', { assunto: item.assunto, erro: String(err) });
      }
    }

    for (const fix of result.correcoes ?? []) {
      const old = this.memories.get(fix.id_memoria);
      if (!old) continue;
      const replacement = await this.memories.remember({
        kind: old.kind,
        subject: old.subject,
        content: fix.novo_conteudo,
        importance: Math.max(old.importance, 0.6),
        confidence: 0.9,
        source: 'correção do dono',
        conversationId,
      });
      if (replacement.id !== old.id) this.memories.supersede(old.id, replacement.id);
      learned++;
      log.info('memória corrigida', { antiga: old.id, nova: replacement.id, motivo: fix.motivo });
    }

    if (learned > 0) {
      bus.emit('memory:learned', {
        count: learned,
        summary: (result.memorias ?? []).map((m) => m.assunto).join('; '),
      });
      log.info('reflexão concluída', { aprendidas: learned, conversa: conversationId });
    }

    return { learned, title: result.titulo_conversa ?? '' };
  }
}

function normalizeKind(raw: string): MemoryKind | null {
  const clean = (raw || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const found = MEMORY_KINDS.find(
    (k) => k.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === clean,
  );
  return found ?? null;
}
