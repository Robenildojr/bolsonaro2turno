/**
 * Agendador cron mínimo, consciente de fuso.
 *
 * Por que não uma biblioteca: o que precisamos é um subconjunto pequeno
 * (curinga, lista, faixa e passo), e a parte que realmente importa — avaliar o horário no
 * fuso do dono, não no do servidor — é onde as bibliotecas costumam pedir
 * dependência extra. O relógio aqui bate a cada 20 s, converte o instante para
 * o fuso configurado e compara os campos.
 *
 * Isso também resolve dois problemas chatos de graça:
 *  - horário de verão: como a comparação é sobre a hora local já convertida,
 *    a regra "todo dia às 8h" continua às 8h;
 *  - relógio suspenso (notebook fechado): ao acordar, o minuto atual é
 *    avaliado normalmente, sem tentar "recuperar" execuções perdidas em rajada.
 */
import { createLogger, describeError } from '../../util/logger.js';

const log = createLogger('cron');

export interface CronJob {
  nome: string;
  expressao: string;
  tarefa: () => void | Promise<void>;
  /** Não deixa duas execuções da mesma tarefa se sobreporem. */
  rodando?: boolean;
  ultimaChave?: string;
}

interface CampoCron {
  valores: Set<number>;
  qualquer: boolean;
}

// Interpreta um campo: `*`, `5`, `1-5`, `*` com passo (`*/2`), `1,3,5`, `9-17/2`.
export function parseCampo(texto: string, min: number, max: number): CampoCron {
  if (texto === '*') return { valores: new Set(), qualquer: true };

  const valores = new Set<number>();
  for (const parte of texto.split(',')) {
    const [faixa, passoTexto] = parte.split('/');
    const passo = passoTexto ? Number(passoTexto) : 1;
    if (!Number.isInteger(passo) || passo < 1) throw new Error(`passo inválido em "${parte}"`);

    let inicio: number;
    let fim: number;
    if (faixa === '*' || faixa === undefined) {
      inicio = min;
      fim = max;
    } else if (faixa.includes('-')) {
      const [a, b] = faixa.split('-').map(Number);
      inicio = a!;
      fim = b!;
    } else {
      inicio = Number(faixa);
      fim = passoTexto ? max : inicio;
    }

    if (!Number.isInteger(inicio) || !Number.isInteger(fim)) {
      throw new Error(`valor inválido em "${parte}"`);
    }
    if (inicio < min || fim > max || inicio > fim) {
      throw new Error(`fora da faixa (${min}-${max}) em "${parte}"`);
    }
    for (let v = inicio; v <= fim; v += passo) valores.add(v);
  }
  return { valores, qualquer: false };
}

export interface CronExpr {
  minuto: CampoCron;
  hora: CampoCron;
  diaDoMes: CampoCron;
  mes: CampoCron;
  diaDaSemana: CampoCron;
}

export function parseCron(expressao: string): CronExpr {
  const campos = expressao.trim().split(/\s+/);
  if (campos.length !== 5) {
    throw new Error(`cron precisa de 5 campos (minuto hora dia mês dia-da-semana): "${expressao}"`);
  }
  return {
    minuto: parseCampo(campos[0]!, 0, 59),
    hora: parseCampo(campos[1]!, 0, 23),
    diaDoMes: parseCampo(campos[2]!, 1, 31),
    mes: parseCampo(campos[3]!, 1, 12),
    diaDaSemana: parseCampo(campos[4]!, 0, 6),
  };
}

export interface MomentoLocal {
  minuto: number;
  hora: number;
  diaDoMes: number;
  mes: number;
  diaDaSemana: number;
  chave: string;
}

/** Decompõe um instante no fuso indicado. */
export function momentoLocal(data: Date, timezone: string): MomentoLocal {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

  const partes: Record<string, string> = {};
  for (const p of fmt.formatToParts(data)) partes[p.type] = p.value;

  const semana: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl devolve 24 para a meia-noite em alguns runtimes; cron usa 0.
  const hora = Number(partes.hour) % 24;

  return {
    minuto: Number(partes.minute),
    hora,
    diaDoMes: Number(partes.day),
    mes: Number(partes.month),
    diaDaSemana: semana[partes.weekday ?? 'Sun'] ?? 0,
    chave: `${partes.year}-${partes.month}-${partes.day}T${String(hora).padStart(2, '0')}:${partes.minute}`,
  };
}

function bate(campo: CampoCron, valor: number): boolean {
  return campo.qualquer || campo.valores.has(valor);
}

/**
 * Verifica se a expressão casa com o momento.
 *
 * Regra herdada do cron do Unix, que surpreende quem não a conhece: quando
 * **dia-do-mês e dia-da-semana** estão ambos restritos, vale o OU entre eles,
 * não o E. "0 9 1 * 1" dispara todo dia 1º **e** toda segunda-feira.
 */
export function casa(expr: CronExpr, m: MomentoLocal): boolean {
  if (!bate(expr.minuto, m.minuto)) return false;
  if (!bate(expr.hora, m.hora)) return false;
  if (!bate(expr.mes, m.mes)) return false;

  const domRestrito = !expr.diaDoMes.qualquer;
  const dowRestrito = !expr.diaDaSemana.qualquer;

  if (domRestrito && dowRestrito) {
    return bate(expr.diaDoMes, m.diaDoMes) || bate(expr.diaDaSemana, m.diaDaSemana);
  }
  return bate(expr.diaDoMes, m.diaDoMes) && bate(expr.diaDaSemana, m.diaDaSemana);
}

export class Scheduler {
  private jobs: Array<CronJob & { expr: CronExpr }> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly timezone: string) {}

  agendar(nome: string, expressao: string, tarefa: () => void | Promise<void>): void {
    const expr = parseCron(expressao);
    this.jobs.push({ nome, expressao, tarefa, expr });
    log.info('tarefa agendada', { nome, quando: expressao, fuso: this.timezone });
  }

  remover(nome: string): boolean {
    const antes = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.nome !== nome);
    return this.jobs.length < antes;
  }

  iniciar(): void {
    if (this.timer) return;
    // 20 s garante que nenhum minuto passe despercebido, e a chave por minuto
    // impede execução dupla dentro do mesmo minuto.
    this.timer = setInterval(() => this.tick(), 20_000);
    this.tick();
    log.info('agendador no ar', { tarefas: this.jobs.length });
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Executa agora, ignorando o horário. Usado pela CLI e pelos testes. */
  async executarAgora(nome: string): Promise<boolean> {
    const job = this.jobs.find((j) => j.nome === nome);
    if (!job) return false;
    await this.rodar(job);
    return true;
  }

  listar(): Array<{ nome: string; expressao: string; rodando: boolean }> {
    return this.jobs.map((j) => ({
      nome: j.nome,
      expressao: j.expressao,
      rodando: Boolean(j.rodando),
    }));
  }

  private tick(): void {
    const m = momentoLocal(new Date(), this.timezone);
    for (const job of this.jobs) {
      if (job.ultimaChave === m.chave) continue;
      if (!casa(job.expr, m)) continue;
      job.ultimaChave = m.chave;
      void this.rodar(job);
    }
  }

  private async rodar(job: CronJob): Promise<void> {
    if (job.rodando) {
      log.warn('execução anterior ainda em andamento — pulando', { nome: job.nome });
      return;
    }
    job.rodando = true;
    const inicio = Date.now();
    try {
      await job.tarefa();
      log.debug('tarefa concluída', { nome: job.nome, ms: Date.now() - inicio });
    } catch (err) {
      log.error('tarefa falhou', { nome: job.nome, erro: describeError(err) });
    } finally {
      job.rodando = false;
    }
  }
}
