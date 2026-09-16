/**
 * Orquestração das rotinas.
 *
 * É aqui que o Gideão deixa de ser reativo. Sem este módulo ele responde bem,
 * mas só quando chamado; com o agendador, ele acompanha o dia: avisa da audiência,
 * percebe a movimentação nova, lê o e-mail do tribunal, consolida a memória de
 * madrugada e faz o backup.
 */
import { loadConfig, type Config } from '../../config.js';
import { getStore } from '../db/database.js';
import { createLogger, describeError } from '../../util/logger.js';
import { bus } from '../events/bus.js';
import { getMemory } from '../memory/index.js';
import { getAgent } from '../agent/agent.js';
import { getAudit } from '../permissions/audit.js';
import { initAgenda, getAgenda } from './agenda.js';
import { initProcessos, getProcessos } from '../../integrations/justice/monitor.js';
import { initEmail, getEmail } from '../../integrations/email/mail.js';
import { Scheduler } from './cron.js';

const log = createLogger('rotinas');

let scheduler: Scheduler | null = null;

export async function startScheduler(cfg: Config = loadConfig()): Promise<Scheduler> {
  const store = getStore();

  const agenda = initAgenda(store);
  initProcessos(store);
  if (cfg.email.enabled) initEmail(cfg, store);

  // A agenda entra no contexto de toda conversa: ele precisa saber o que está
  // marcado antes de responder qualquer coisa sobre o dia.
  getAgent().setAgendaProvider(() => {
    try {
      return agenda.resumoParaContexto();
    } catch {
      return '';
    }
  });

  scheduler = new Scheduler(cfg.timezone);

  // ── a cada minuto: avisos ──────────────────────────────────────────────────
  scheduler.agendar('avisos', '* * * * *', () => {
    getAgenda().despacharAvisos();
  });

  // ── madrugada: consolidação da memória ─────────────────────────────────────
  scheduler.agendar('consolidacao', cfg.memory.consolidationCron, async () => {
    log.info('iniciando consolidação noturna');
    const r = await getMemory().consolidate();
    getAudit().record({ action: 'rotina.consolidacao', detail: r as unknown as Record<string, unknown> });
  });

  // ── madrugada: manutenção do banco ─────────────────────────────────────────
  scheduler.agendar('manutencao', '30 4 * * 0', async () => {
    getStore().maintenance();
    getAudit().prune(365);
    const { limparAntigos } = await import('../agent/attachments.js');
    await limparAntigos(90);
    log.info('manutenção semanal do banco concluída');
  });

  // ── processos ──────────────────────────────────────────────────────────────
  if (cfg.justice.enabled) {
    scheduler.agendar('processos', cfg.justice.monitorCron, async () => {
      const r = await getProcessos().verificarTodos();
      getAudit().record({ action: 'rotina.processos', detail: r });
    });
  }

  // ── e-mail ─────────────────────────────────────────────────────────────────
  if (cfg.email.enabled) {
    scheduler.agendar('email', cfg.email.pollCron, async () => {
      try {
        await getEmail().verificarNovos();
      } catch (err) {
        // Falha de e-mail não pode derrubar o resto das rotinas.
        log.warn('verificação de e-mail falhou', { erro: describeError(err) });
      }
    });
  }

  // ── backup cifrado ─────────────────────────────────────────────────────────
  // A senha-mestra precisa estar no ambiente para o backup automático rodar:
  // a chave do pacote é derivada dela, e é isso que permite restaurar em outra
  // máquina. Sem ela, o backup fica manual (`gideao backup agora`).
  if (process.env.GIDEAO_PASSPHRASE) {
    scheduler.agendar('backup', cfg.drive.backupCron, async () => {
      const { getBackup } = await import('../../integrations/drive/backup.js');
      const r = await getBackup(cfg).executar(process.env.GIDEAO_PASSPHRASE!);
      log.info('backup automático', { arquivo: r.arquivo, drive: Boolean(r.drive) });
    });
  } else {
    log.info(
      'backup automático desligado: GIDEAO_PASSPHRASE não está no ambiente. ' +
        'Use `gideao backup agora` quando quiser gerar um.',
    );
  }

  // ── digestão do observador ─────────────────────────────────────────────────
  // Uma vez por dia: o material cru vira padrão, e o cru segue seu prazo.
  if (cfg.observer.enabled) {
    scheduler.agendar('observacoes', '15 3 * * *', async () => {
      const { getObservador } = await import('../../observer/index.js');
      const n = await getObservador().digerir();
      if (n > 0) log.info('observações do dia viraram memória', { total: n });
    });
  }

  // ── estudar sozinho, de madrugada ──────────────────────────────────────────
  //
  // Às 5h: depois da consolidação das 3h, para o que ele aprender hoje já
  // encontrar a memória arrumada, e antes do panorama das 7h, para a novidade
  // chegar junto com o resto do dia em vez de sozinha no meio da tarde.
  if (cfg.updates.conhecimento) {
    scheduler.agendar('estudo', cfg.updates.conhecimentoCron, async () => {
      const { rotinaConhecimento } = await import('../updates/index.js');
      await rotinaConhecimento();
    });
  }

  // ── conferir versão de código e de modelo ──────────────────────────────────
  if (cfg.updates.codigo || cfg.updates.modelo) {
    scheduler.agendar('versoes', cfg.updates.codigoCron, async () => {
      const { rotinaVersoes } = await import('../updates/index.js');
      await rotinaVersoes();
    });
  }

  // ── panorama da manhã ──────────────────────────────────────────────────────
  scheduler.agendar('panorama', '0 7 * * 1-5', () => {
    const resumo = getAgenda().resumoParaContexto();
    if (!resumo.trim()) return;
    bus.emit('notify', {
      id: `panorama_${Date.now()}`,
      title: 'Seu dia',
      body: resumo,
      kind: 'panorama',
      urgency: 'normal',
    });
  });

  // ── fechamento do dia ──────────────────────────────────────────────────────
  scheduler.agendar('fechamento', '0 19 * * 1-5', () => {
    const abertas = getAgenda().listarTarefas('aberta', 5);
    if (abertas.length === 0) return;
    bus.emit('notify', {
      id: `fechamento_${Date.now()}`,
      title: 'Ficou pendente',
      body: abertas.map((t) => `• ${t.titulo}`).join('\n'),
      kind: 'fechamento',
      urgency: 'low',
    });
  });

  scheduler.iniciar();
  log.info('rotinas no ar', { tarefas: scheduler.listar().map((t) => t.nome) });
  return scheduler;
}

export function getScheduler(): Scheduler | null {
  return scheduler;
}

export function stopScheduler(): void {
  scheduler?.parar();
  scheduler = null;
}

export { Scheduler } from './cron.js';
