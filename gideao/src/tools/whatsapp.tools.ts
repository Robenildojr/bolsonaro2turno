/**
 * Ferramenta de WhatsApp.
 *
 * Mandar mensagem para você mesmo é rotina — é como ele te avisa de um prazo
 * quando você está fora. Mandar para terceiro é outra coisa: sai em seu nome,
 * chega de verdade e não tem desfazer. Por isso o escopo da autorização é o
 * **número de destino**: liberar "sempre" para você não libera para ninguém
 * mais, e cada contato novo passa por uma decisão sua.
 */
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { getWhatsApp } from '../channels/whatsapp/index.js';
import { normalizarNumero, mesmoNumero } from '../channels/whatsapp/provider.js';
import type { ToolDefinition } from '../core/agent/tools.js';

const enviarWhatsapp: ToolDefinition<{ para: string; mensagem: string }> = {
  name: 'enviar_whatsapp',
  description:
    'Envia mensagem de WhatsApp. Deixe "para" vazio para mandar ao próprio dono — é o caminho normal para avisos e lembretes. Informe um número só quando ele pedir explicitamente que você fale com outra pessoa.',
  capability: 'whatsapp.enviar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['para', 'mensagem'],
    properties: {
      para: {
        type: 'string',
        description: 'Número em E.164 sem +, ex.: 5596991234567. Vazio = o próprio dono.',
      },
      mensagem: { type: 'string', description: 'Texto da mensagem. Sem markdown pesado.' },
    },
  },
  validate: z.object({ para: z.string(), mensagem: z.string().min(1).max(8000) }),
  scopeFrom: (i) => {
    const cfg = loadConfig();
    const destino = i.para.trim() ? normalizarNumero(i.para) : normalizarNumero(cfg.whatsapp.owner);
    return mesmoNumero(destino, cfg.whatsapp.owner) ? 'dono' : destino;
  },
  summarize: (i) => {
    const cfg = loadConfig();
    const paraDono = !i.para.trim() || mesmoNumero(i.para, cfg.whatsapp.owner);
    return paraDono
      ? `mandar no seu WhatsApp: ${i.mensagem.slice(0, 90)}`
      : `MANDAR MENSAGEM PARA TERCEIRO (${i.para}): ${i.mensagem.slice(0, 90)}`;
  },
  async run(input) {
    const canal = getWhatsApp();
    if (!canal) {
      return {
        ok: false,
        content: 'O canal WhatsApp não está ligado. Configure em .env (WHATSAPP_ENABLED=true) e reinicie.',
      };
    }

    const cfg = loadConfig();
    const paraDono = !input.para.trim() || mesmoNumero(input.para, cfg.whatsapp.owner);

    if (paraDono) {
      await canal.enviarAoDono(input.mensagem);
      return { ok: true, content: 'Mandei no seu WhatsApp.' };
    }

    return {
      ok: false,
      content:
        'Enviar para números que não sejam o do dono ainda não está implementado. ' +
        'A Cloud API exige que o destinatário tenha iniciado a conversa nas últimas 24h ou ' +
        'que a mensagem use um modelo aprovado pela Meta — os dois casos precisam de decisão ' +
        'consciente do dono. Diga a ele o que você mandaria e deixe que ele envie.',
    };
  },
};

export const whatsappTools: Array<ToolDefinition<any>> = [enviarWhatsapp];
