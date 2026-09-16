import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.GIDEAO_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { Agenda, proximaOcorrencia } from '../src/core/scheduler/agenda.js';
import { casa, momentoLocal, parseCampo, parseCron, Scheduler } from '../src/core/scheduler/cron.js';
import {
  aliasDoTribunal,
  extrairAudiencia,
  formatarNumero,
  hashDoEstado,
  limparNumero,
} from '../src/integrations/justice/datajud.js';
import { bus } from '../src/core/events/bus.js';
import { DAY } from '../src/util/time.js';

let tmp: string;
let store: Store;
let agenda: Agenda;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gideao-agenda-'));
  process.env.GIDEAO_HOME = tmp;
  const keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create('senha-mestra-forte-123!');
  store = new Store(path.join(tmp, 'gideao.db'), keyring);
  agenda = new Agenda(store);
});

after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.GIDEAO_HOME;
});

describe('campos de cron', () => {
  it('curinga aceita qualquer valor', () => {
    const campo = parseCampo('*', 0, 59);
    assert.equal(campo.qualquer, true);
  });

  it('valor único', () => {
    assert.deepEqual([...parseCampo('30', 0, 59).valores], [30]);
  });

  it('faixa', () => {
    assert.deepEqual([...parseCampo('1-5', 0, 59).valores], [1, 2, 3, 4, 5]);
  });

  it('lista', () => {
    assert.deepEqual([...parseCampo('8,14,19', 0, 23).valores], [8, 14, 19]);
  });

  it('passo sobre curinga', () => {
    assert.deepEqual([...parseCampo('*/15', 0, 59).valores], [0, 15, 30, 45]);
  });

  it('passo sobre faixa', () => {
    assert.deepEqual([...parseCampo('9-17/4', 0, 23).valores], [9, 13, 17]);
  });

  it('recusa valor fora da faixa', () => {
    assert.throws(() => parseCampo('60', 0, 59), /fora da faixa/);
    assert.throws(() => parseCampo('5-2', 0, 59), /fora da faixa/);
  });

  it('recusa expressão com número de campos errado', () => {
    assert.throws(() => parseCron('* * *'), /5 campos/);
    assert.throws(() => parseCron('* * * * * *'), /5 campos/);
  });
});

describe('avaliação de cron', () => {
  const momento = (minuto: number, hora: number, diaDoMes: number, mes: number, diaDaSemana: number) => ({
    minuto,
    hora,
    diaDoMes,
    mes,
    diaDaSemana,
    chave: 'x',
  });

  it('"a cada minuto" sempre casa', () => {
    assert.ok(casa(parseCron('* * * * *'), momento(0, 0, 1, 1, 0)));
    assert.ok(casa(parseCron('* * * * *'), momento(37, 13, 25, 9, 4)));
  });

  it('hora marcada casa só na hora certa', () => {
    const expr = parseCron('30 14 * * *');
    assert.ok(casa(expr, momento(30, 14, 5, 3, 2)));
    assert.ok(!casa(expr, momento(31, 14, 5, 3, 2)));
    assert.ok(!casa(expr, momento(30, 15, 5, 3, 2)));
  });

  it('dias úteis', () => {
    const expr = parseCron('0 7 * * 1-5');
    assert.ok(casa(expr, momento(0, 7, 10, 6, 1)), 'segunda');
    assert.ok(casa(expr, momento(0, 7, 14, 6, 5)), 'sexta');
    assert.ok(!casa(expr, momento(0, 7, 15, 6, 6)), 'sábado');
    assert.ok(!casa(expr, momento(0, 7, 16, 6, 0)), 'domingo');
  });

  it('dia-do-mês e dia-da-semana juntos valem como OU, como no cron do Unix', () => {
    const expr = parseCron('0 9 1 * 1');
    assert.ok(casa(expr, momento(0, 9, 1, 5, 4)), 'dia 1º, numa quinta');
    assert.ok(casa(expr, momento(0, 9, 12, 5, 1)), 'segunda-feira, dia 12');
    assert.ok(!casa(expr, momento(0, 9, 12, 5, 4)), 'nem dia 1º nem segunda');
  });

  it('restringir só um dos dois mantém o E', () => {
    const expr = parseCron('0 9 15 * *');
    assert.ok(casa(expr, momento(0, 9, 15, 5, 3)));
    assert.ok(!casa(expr, momento(0, 9, 16, 5, 3)));
  });
});

describe('momento no fuso do dono', () => {
  it('converte para o fuso pedido, não o do servidor', () => {
    // 2026-09-14T12:00Z = 09:00 em São Paulo (UTC-3)
    const m = momentoLocal(new Date('2026-09-14T12:00:00Z'), 'America/Sao_Paulo');
    assert.equal(m.hora, 9);
    assert.equal(m.minuto, 0);
    assert.equal(m.diaDoMes, 14);
    assert.equal(m.mes, 9);
    assert.equal(m.diaDaSemana, 1, 'segunda-feira');
  });

  it('meia-noite é hora 0, não 24', () => {
    const m = momentoLocal(new Date('2026-09-14T03:00:00Z'), 'America/Sao_Paulo');
    assert.equal(m.hora, 0);
  });

  it('a chave identifica o minuto — é o que evita execução dupla', () => {
    const a = momentoLocal(new Date('2026-09-14T12:00:30Z'), 'America/Sao_Paulo');
    const b = momentoLocal(new Date('2026-09-14T12:00:59Z'), 'America/Sao_Paulo');
    const c = momentoLocal(new Date('2026-09-14T12:01:00Z'), 'America/Sao_Paulo');
    assert.equal(a.chave, b.chave);
    assert.notEqual(a.chave, c.chave);
  });

  it('fusos diferentes dão horas diferentes para o mesmo instante', () => {
    const instante = new Date('2026-09-14T12:00:00Z');
    assert.notEqual(
      momentoLocal(instante, 'America/Sao_Paulo').hora,
      momentoLocal(instante, 'Europe/Lisbon').hora,
    );
  });
});

describe('agendador', () => {
  it('executa sob demanda e não deixa sobrepor', async () => {
    const s = new Scheduler('America/Sao_Paulo');
    let execucoes = 0;
    s.agendar('teste', '0 3 * * *', async () => {
      execucoes++;
      await new Promise((r) => setTimeout(r, 30));
    });

    await s.executarAgora('teste');
    assert.equal(execucoes, 1);
    assert.equal(await s.executarAgora('inexistente'), false);
  });

  it('erro numa tarefa não derruba o agendador', async () => {
    const s = new Scheduler('America/Sao_Paulo');
    s.agendar('quebra', '* * * * *', () => {
      throw new Error('falhei de propósito');
    });
    await s.executarAgora('quebra'); // não pode lançar
    assert.equal(s.listar().length, 1);
  });

  it('recusa expressão inválida no momento do agendamento', () => {
    const s = new Scheduler('America/Sao_Paulo');
    assert.throws(() => s.agendar('ruim', 'todo dia', () => {}), /5 campos/);
  });
});

describe('lembretes', () => {
  it('cria e recupera', () => {
    const daqui = Date.now() + 3 * DAY;
    const l = agenda.criarLembrete({
      titulo: 'Audiência Almeida x Transportes Norte',
      corpo: '2ª Vara do Trabalho de Macapá',
      quando: daqui,
      tipo: 'audiencia',
    });
    const lido = agenda.obterLembrete(l.id)!;
    assert.equal(lido.titulo, 'Audiência Almeida x Transportes Norte');
    assert.equal(lido.tipo, 'audiencia');
    assert.equal(lido.status, 'pendente');
  });

  it('antecedência padrão muda conforme o tipo', () => {
    const base = Date.now() + 10 * DAY;
    const audiencia = agenda.criarLembrete({ titulo: 'a', quando: base, tipo: 'audiencia' });
    const prazo = agenda.criarLembrete({ titulo: 'b', quando: base, tipo: 'prazo' });
    const comum = agenda.criarLembrete({ titulo: 'c', quando: base, tipo: 'compromisso' });

    assert.equal(audiencia.antecedenciaMin, 24 * 60, 'audiência avisa com um dia');
    assert.equal(prazo.antecedenciaMin, 48 * 60, 'prazo avisa com dois dias');
    assert.equal(comum.antecedenciaMin, 60);
  });

  it('não deixa o título legível no arquivo do banco', () => {
    const bruto = store.db.prepare('SELECT title_enc FROM reminders LIMIT 1').get() as {
      title_enc: Buffer;
    };
    assert.ok(!bruto.title_enc.toString('utf8').includes('Audiência'));
  });

  it('dispara o aviso respeitando a antecedência', async () => {
    store.db.exec('DELETE FROM reminders');
    const avisos: string[] = [];
    const off = bus.on('notify', (e) => avisos.push(e.title));

    // Daqui a 30 min, com antecedência de 60: já deve avisar.
    agenda.criarLembrete({
      titulo: 'Reunião com o cliente',
      quando: Date.now() + 30 * 60_000,
      antecedenciaMin: 60,
      tipo: 'compromisso',
    });
    // Daqui a 5 dias, com antecedência de 60 min: ainda não.
    agenda.criarLembrete({
      titulo: 'Coisa distante',
      quando: Date.now() + 5 * DAY,
      antecedenciaMin: 60,
      tipo: 'compromisso',
    });

    const disparados = agenda.despacharAvisos();
    await new Promise((r) => setTimeout(r, 20));
    off();

    assert.equal(disparados, 1);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0]!, /Compromisso/);
  });

  it('não avisa duas vezes o mesmo lembrete', () => {
    store.db.exec('DELETE FROM reminders');
    agenda.criarLembrete({ titulo: 'x', quando: Date.now() + 60_000, antecedenciaMin: 120 });
    assert.equal(agenda.despacharAvisos(), 1);
    assert.equal(agenda.despacharAvisos(), 0, 'segunda passagem não pode repetir');
  });

  it('lembrete repetitivo volta para pendente com data nova', () => {
    store.db.exec('DELETE FROM reminders');
    const quando = Date.now() + 60_000;
    agenda.criarLembrete({
      titulo: 'Reunião semanal',
      quando,
      antecedenciaMin: 120,
      repeticao: 'semanal',
    });
    agenda.despacharAvisos();

    const proximos = agenda.proximos(30, 10);
    const reagendado = proximos.find((l) => l.titulo === 'Reunião semanal');
    assert.ok(reagendado);
    assert.equal(reagendado!.status, 'pendente');
    assert.ok(reagendado!.quando > quando + 6 * DAY);
  });

  it('calcula a próxima ocorrência de cada repetição', () => {
    const base = new Date('2026-09-14T14:00:00Z').getTime(); // segunda-feira
    assert.equal(proximaOcorrencia(base, 'diario'), base + DAY);
    assert.equal(proximaOcorrencia(base, 'semanal'), base + 7 * DAY);
    assert.equal(proximaOcorrencia(base, 'quinzenal'), base + 14 * DAY);
    assert.equal(proximaOcorrencia(base, 'inventada'), null);

    const mensal = proximaOcorrencia(base, 'mensal')!;
    assert.equal(new Date(mensal).getMonth(), new Date(base).getMonth() + 1);
  });

  it('dia útil pula o fim de semana', () => {
    // Sexta-feira, 18/09/2026
    const sexta = new Date(2026, 8, 18, 10, 0).getTime();
    const proximo = proximaOcorrencia(sexta, 'util')!;
    assert.equal(new Date(proximo).getDay(), 1, 'deve cair na segunda');
  });
});

describe('tarefas', () => {
  it('cria, lista e conclui', () => {
    const t = agenda.criarTarefa({ titulo: 'Protocolar apelação', prioridade: 1 });
    assert.ok(agenda.listarTarefas('aberta').some((x) => x.id === t.id));

    agenda.atualizarTarefa(t.id, { status: 'concluida' });
    assert.ok(!agenda.listarTarefas('aberta').some((x) => x.id === t.id));
    assert.equal(agenda.obterTarefa(t.id)!.concluidaEm !== null, true);
  });

  it('ordena por prioridade', () => {
    store.db.exec('DELETE FROM tasks');
    agenda.criarTarefa({ titulo: 'quando der', prioridade: 3 });
    agenda.criarTarefa({ titulo: 'urgente', prioridade: 1 });
    agenda.criarTarefa({ titulo: 'normal', prioridade: 2 });
    assert.deepEqual(
      agenda.listarTarefas('aberta').map((t) => t.titulo),
      ['urgente', 'normal', 'quando der'],
    );
  });
});

describe('número CNJ', () => {
  it('limpa e formata', () => {
    assert.equal(limparNumero('0001234-56.2024.5.08.0011'), '00012345620245080011');
    assert.equal(formatarNumero('00012345620245080011'), '0001234-56.2024.5.08.0011');
  });

  it('deriva o tribunal do segmento e do código', () => {
    assert.equal(aliasDoTribunal('0001234-56.2024.5.08.0011'), 'api_publica_trt8', 'trabalho');
    assert.equal(aliasDoTribunal('0001234-56.2024.4.01.0011'), 'api_publica_trf1', 'federal');
    assert.equal(aliasDoTribunal('0001234-56.2024.8.03.0011'), 'api_publica_tjap', 'estadual Amapá');
    assert.equal(aliasDoTribunal('0001234-56.2024.8.26.0011'), 'api_publica_tjsp', 'estadual SP');
  });

  it('recusa número incompleto', () => {
    assert.equal(aliasDoTribunal('123456'), null);
    assert.equal(aliasDoTribunal(''), null);
  });
});

describe('detecção de audiência em movimentação', () => {
  it('encontra data e hora', () => {
    const achado = extrairAudiencia({
      codigo: 970,
      nome: 'Audiência de instrução designada',
      data: '2026-09-14T10:00:00',
      complementos: ['designada para 20/10/2026 às 14:30'],
    });
    assert.ok(achado);
    assert.equal(achado!.data.getDate(), 20);
    assert.equal(achado!.data.getMonth(), 9);
    assert.equal(achado!.data.getHours(), 14);
    assert.equal(achado!.data.getMinutes(), 30);
  });

  it('assume 9h quando não há hora', () => {
    const achado = extrairAudiencia({
      codigo: 970,
      nome: 'Audiência designada para 20/10/2026',
      data: '2026-09-14T10:00:00',
      complementos: [],
    });
    assert.equal(achado!.data.getHours(), 9);
  });

  it('ignora movimentação que não é audiência', () => {
    assert.equal(
      extrairAudiencia({
        codigo: 123,
        nome: 'Juntada de petição em 20/10/2026',
        data: '2026-09-14T10:00:00',
        complementos: [],
      }),
      null,
    );
  });

  it('ignora data no passado — não serve para lembrete', () => {
    assert.equal(
      extrairAudiencia({
        codigo: 970,
        nome: 'Audiência realizada em 20/10/2020',
        data: '2020-10-20T10:00:00',
        complementos: [],
      }),
      null,
    );
  });
});

describe('impressão digital do processo', () => {
  it('muda quando chega movimentação nova', () => {
    const base = {
      numero: '0001234-56.2024.5.08.0011',
      tribunal: 'TRT8',
      classe: 'RTOrd',
      assuntos: [],
      orgaoJulgador: '',
      grau: 'G1',
      ajuizamento: '',
      ultimaAtualizacao: '',
      movimentos: [{ codigo: 1, nome: 'Distribuição', data: '2024-01-10T10:00:00', complementos: [] }],
    };
    const antes = hashDoEstado(base);
    const depois = hashDoEstado({
      ...base,
      movimentos: [
        { codigo: 2, nome: 'Sentença', data: '2026-09-14T10:00:00', complementos: [] },
        ...base.movimentos,
      ],
    });
    assert.notEqual(antes, depois);
    assert.equal(hashDoEstado(base), antes, 'sem mudança, o hash é o mesmo');
  });
});
