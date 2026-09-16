/**
 * Canal WhatsApp.
 *
 * Duas coisas importam aqui, e as duas são de segurança:
 *
 *  1. **Só o dono fala com ele.** Mensagem de qualquer outro número é
 *     descartada e registrada. O Gideão tem acesso ao computador, ao cofre e ao
 *     e-mail — um desconhecido conseguindo conversar com ele seria acesso
 *     remoto à sua máquina por uma mensagem de texto.
 *
 *  2. **Autorização também funciona pelo WhatsApp.** Se ele precisar de
 *     permissão enquanto você está na rua, a pergunta chega no celular e você
 *     responde com um número. Sem isso, toda tarefa que dependesse de
 *     autorização morreria esperando você voltar para o computador.
 *
 * A conversa é a mesma dos outros canais: o que você começou na tela continua
 * no celular, com a mesma memória.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { bus } from '../../core/events/bus.js';
import { getAgent } from '../../core/agent/agent.js';
import { getMemory } from '../../core/memory/index.js';
import { getBroker } from '../../core/permissions/broker.js';
import { createLogger, describeError } from '../../util/logger.js';
import type { Decision } from '../../core/permissions/capabilities.js';
import { CloudApiProvider } from './cloud.js';
import { BaileysProvider } from './baileys.js';
import { dividirMensagem, mesmoNumero, type MensagemRecebida, type WhatsAppProvider } from './provider.js';
import { guardar, type Anexo } from '../../core/agent/attachments.js';

const log = createLogger('whatsapp');

/** Como o dono responde a um pedido de autorização pelo celular. */
const RESPOSTAS: Array<[RegExp, Decision]> = [
  [/^\s*(1|agora|so agora|só agora|sim)\b/i, 'uma_vez'],
  [/^\s*(2|sempre|sempre aqui)\b/i, 'sempre'],
  [/^\s*(3|tudo|sempre tudo|libera tudo)\b/i, 'categoria'],
  [/^\s*(4|nao|não|n)\b/i, 'negado'],
  [/^\s*(5|nunca|jamais)\b/i, 'negado_sempre'],
];

export class WhatsAppChannel {
  private provider: WhatsAppProvider;
  private conversationId: string | null = null;
  private pendente: { id: string; expiraEm: number } | null = null;
  private desinscrever: Array<() => void> = [];
  private ocupada = false;

  constructor(
    private readonly cfg: Config,
    app: FastifyInstance,
  ) {
    this.provider =
      cfg.whatsapp.provider === 'baileys'
        ? new BaileysProvider(cfg)
        : new CloudApiProvider(cfg, app);
  }

  async start(): Promise<void> {
    if (!this.cfg.whatsapp.owner) {
      throw new Error(
        'WHATSAPP_OWNER vazio. Sem o seu número, eu não teria como distinguir você de um desconhecido.',
      );
    }

    this.provider.aoReceber((msg) => this.receber(msg));
    await this.provider.iniciar();

    // Pergunta de autorização vai para o celular quando a conversa ativa é o
    // WhatsApp — e também quando é a única maneira de te alcançar.
    this.desinscrever.push(
      bus.on('permission:request', (evento) => {
        void this.perguntarAutorizacao(evento);
      }),
    );

    // Lembretes, audiências e movimentações chegam no celular.
    this.desinscrever.push(
      bus.on('notify', (evento) => {
        void this.enviarAoDono(
          `*${evento.title}*\n${evento.body}`,
        ).catch((err) => log.warn('não consegui notificar pelo WhatsApp', { erro: describeError(err) }));
      }),
    );

    log.info('canal WhatsApp no ar', {
      provedor: this.provider.nome,
      dono: mascarar(this.cfg.whatsapp.owner),
    });
  }

  async stop(): Promise<void> {
    for (const off of this.desinscrever) off();
    this.desinscrever = [];
    await this.provider.parar();
  }

  // ── recebimento ────────────────────────────────────────────────────────────

  private async receber(msg: MensagemRecebida): Promise<void> {
    if (!mesmoNumero(msg.de, this.cfg.whatsapp.owner)) {
      log.warn('mensagem de número não autorizado — ignorada', { de: mascarar(msg.de) });
      return;
    }

    const texto = msg.texto.trim();

    // Foto de documento e PDF são a forma mais natural de mandar material pelo
    // WhatsApp — a mídia é baixada aqui e vai para o modelo como anexo de
    // verdade, não como aviso de que "chegou uma imagem".
    const anexos = await this.baixarAnexos(msg);

    if (!texto && anexos.length === 0) {
      if (msg.tipo === 'audio') {
        await this.enviarAoDono(
          'Recebi o áudio, mas ainda não transcrevo áudio do WhatsApp. Manda por escrito ou pela tela.',
        );
      }
      return;
    }

    // Se há autorização pendente, a mensagem é lida como a resposta dela.
    if (this.pendente && Date.now() < this.pendente.expiraEm) {
      const decisao = interpretarResposta(texto);
      if (decisao) {
        const resolvida = getBroker().resolve(this.pendente.id, decisao);
        this.pendente = null;
        await this.enviarAoDono(
          resolvida
            ? decisao.startsWith('negado')
              ? 'Ok, não faço.'
              : 'Autorizado — sigo daqui.'
            : 'Esse pedido já tinha expirado.',
        );
        return;
      }
      // Não parecia resposta: segue como conversa normal e o pedido continua de pé.
    }

    if (this.ocupada) {
      await this.enviarAoDono('Ainda estou terminando o anterior. Já respondo.');
      return;
    }

    try {
      this.ocupada = true;
      const conversationId = this.conversaAtual();
      const resultado = await getAgent().run({
        conversationId,
        channel: 'whatsapp',
        text: texto || `Veja o que eu mandei: ${anexos.map((a) => a.nome).join(', ')}.`,
        ...(anexos.length ? { attachments: anexos } : {}),
      });

      const resposta = resultado.text?.trim();
      if (resposta) {
        await this.enviarAoDono(resposta);
      } else if (resultado.interrupted) {
        await this.enviarAoDono('Interrompi aqui.');
      } else {
        await this.enviarAoDono('Terminei, mas não tenho nada para dizer sobre isso.');
      }
    } catch (err) {
      log.error('falha ao responder no WhatsApp', { erro: describeError(err) });
      await this.enviarAoDono(`Deu erro aqui: ${describeError(err)}`).catch(() => {});
    } finally {
      this.ocupada = false;
    }
  }

  /** Baixa a mídia da mensagem, se houver e se o provedor souber. */
  private async baixarAnexos(msg: MensagemRecebida): Promise<Anexo[]> {
    if (!msg.midia || !this.provider.baixarMidia) return [];

    try {
      const bytes = await this.provider.baixarMidia(msg.midia);
      if (!bytes) return [];
      const anexo = await guardar(bytes, { nome: msg.midia.nome, mime: msg.midia.mime });
      log.info('mídia recebida pelo WhatsApp', { tipo: anexo.tipo, kb: Math.round(anexo.bytes / 1024) });
      return [anexo];
    } catch (err) {
      log.warn('não consegui aproveitar a mídia', { erro: describeError(err) });
      await this.enviarAoDono(`Recebi o arquivo mas não consegui abrir: ${describeError(err)}`).catch(
        () => {},
      );
      return [];
    }
  }

  // ── autorização pelo celular ───────────────────────────────────────────────

  private async perguntarAutorizacao(evento: {
    id: string;
    capability: string;
    scope: string;
    risk: string;
    reason: string;
    details: Record<string, unknown>;
    expiresAt: number;
  }): Promise<void> {
    // Só encaminha se não houver ninguém olhando a tela — senão o dono
    // receberia a mesma pergunta em dois lugares.
    const { getHttpChannel } = await import('../http/server.js');
    const naTela = (getHttpChannel()?.connectedClients ?? 0) > 0;
    if (naTela) return;

    this.pendente = { id: evento.id, expiraEm: evento.expiresAt };

    const rotulo = String(evento.details.rotulo ?? evento.capability);
    const explicacao = String(evento.details.explicacao ?? '');
    const segundos = Math.max(0, Math.round((evento.expiresAt - Date.now()) / 1000));

    await this.enviarAoDono(
      [
        `*Preciso de autorização* (risco ${evento.risk})`,
        '',
        `${rotulo}`,
        explicacao,
        '',
        `Alvo: ${evento.scope}`,
        `Motivo: ${evento.reason}`,
        '',
        'Responda:',
        '1 — agora',
        '2 — sempre neste alvo',
        '3 — sempre, para tudo',
        '4 — não',
        '5 — nunca',
        '',
        `Sem resposta em ${segundos}s, considero negado.`,
      ]
        .filter((l) => l !== undefined)
        .join('\n'),
    ).catch((err) => log.warn('não consegui pedir autorização pelo WhatsApp', { erro: describeError(err) }));
  }

  // ── envio ──────────────────────────────────────────────────────────────────

  async enviarAoDono(texto: string): Promise<void> {
    for (const parte of dividirMensagem(texto)) {
      await this.provider.enviar(this.cfg.whatsapp.owner, parte);
    }
  }

  private conversaAtual(): string {
    if (!this.conversationId) {
      this.conversationId = getMemory().conversations.current('whatsapp').id;
    }
    return this.conversationId;
  }

  get pronto(): boolean {
    return this.provider.pronto;
  }
}

function interpretarResposta(texto: string): Decision | null {
  for (const [padrao, decisao] of RESPOSTAS) {
    if (padrao.test(texto)) return decisao;
  }
  return null;
}

/** Mostra só o começo e o fim do número nos logs. */
function mascarar(numero: string): string {
  if (numero.length < 6) return '***';
  return `${numero.slice(0, 4)}***${numero.slice(-2)}`;
}

let singleton: WhatsAppChannel | null = null;

export async function startWhatsApp(cfg: Config, app: FastifyInstance): Promise<WhatsAppChannel> {
  singleton = new WhatsAppChannel(cfg, app);
  await singleton.start();
  return singleton;
}

export function getWhatsApp(): WhatsAppChannel | null {
  return singleton;
}
