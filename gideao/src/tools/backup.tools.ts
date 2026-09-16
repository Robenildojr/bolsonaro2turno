/**
 * Ferramenta de backup.
 *
 * Ele consegue **disparar** o backup, mas não consegue gerar um sem a
 * senha-mestra — que ele não tem. Se a senha não estiver no ambiente, a
 * ferramenta explica em vez de fingir que fez.
 */
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { getBackup } from '../integrations/drive/backup.js';
import type { ToolDefinition } from '../core/agent/tools.js';

const fazerBackup: ToolDefinition<{ enviar_ao_drive: boolean }> = {
  name: 'fazer_backup',
  description:
    'Gera agora um backup cifrado da memória, do cofre e da agenda. Sempre grava a cópia local; envia ao Google Drive se estiver configurado.',
  capability: 'drive.gravar',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['enviar_ao_drive'],
    properties: {
      enviar_ao_drive: { type: 'boolean', description: 'false = só a cópia local.' },
    },
  },
  validate: z.object({ enviar_ao_drive: z.boolean() }),
  scopeFrom: () => '*',
  summarize: (i) => `fazer backup cifrado${i.enviar_ao_drive ? ' e enviar ao Drive' : ' (só local)'}`,
  timeoutMs: 600_000,
  async run(input) {
    const senha = process.env.GIDEAO_PASSPHRASE;
    if (!senha) {
      return {
        ok: false,
        content:
          'Não consigo gerar o backup sozinho: a chave do pacote é derivada da senha-mestra, e eu ' +
          'não a tenho em memória. O dono pode rodar `npm run gideao -- backup agora` no terminal, ' +
          'ou deixar GIDEAO_PASSPHRASE no ambiente para o backup automático funcionar.',
      };
    }

    const cfg = loadConfig();
    const r = await getBackup(cfg).executar(senha, { enviarAoDrive: input.enviar_ao_drive });
    return {
      ok: true,
      content:
        `Backup feito: ${r.arquivo} (${Math.round(r.bytes / 1024)} KB)\n` +
        `Cópia local: ${r.local}\n` +
        (r.drive ? 'Enviado ao Google Drive, já cifrado.\n' : 'Drive não configurado ou indisponível.\n') +
        `\n${r.resumo}`,
    };
  },
};

const listarBackups: ToolDefinition<Record<string, never>> = {
  name: 'listar_backups',
  description: 'Lista os backups existentes, locais e no Drive.',
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  summarize: () => 'listar os backups',
  async run() {
    const backup = getBackup();
    const locais = await backup.listarLocais();
    const partes: string[] = [];

    partes.push(
      locais.length > 0
        ? 'LOCAIS:\n' +
            locais
              .slice(0, 10)
              .map((b) => `- ${b.arquivo} · ${Math.round(b.bytes / 1024)} KB · ${b.em.toLocaleString('pt-BR')}`)
              .join('\n')
        : 'Nenhum backup local ainda.',
    );

    if (backup.driveConfigurado && backup.driveAutorizado) {
      try {
        const noDrive = await backup.listarNoDrive();
        partes.push(
          'NO DRIVE:\n' +
            noDrive
              .slice(0, 10)
              .map(
                (b) =>
                  `- ${b.name} · ${Math.round(b.size / 1024)} KB · ${new Date(b.createdTime).toLocaleString('pt-BR')}`,
              )
              .join('\n'),
        );
      } catch (err) {
        partes.push(`Não consegui listar o Drive: ${String(err)}`);
      }
    }

    return { ok: true, content: partes.join('\n\n') };
  },
};

export const backupTools: Array<ToolDefinition<any>> = [fazerBackup, listarBackups];
