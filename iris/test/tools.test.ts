import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.IRIS_KDF_N = '16384';

import { Keyring } from '../src/core/crypto/keyring.js';
import { Store } from '../src/core/db/database.js';
import { initAudit } from '../src/core/permissions/audit.js';
import { initBroker, type PermissionBroker } from '../src/core/permissions/broker.js';
import { initVault } from '../src/core/vault/vault.js';
import { ToolRegistry } from '../src/core/agent/tools.js';
import { fsTools, isProtectedPath, resolvePath } from '../src/tools/fs.tools.js';
import { commandScope, splitArgs, shellTools } from '../src/tools/shell.tools.js';
import { htmlToText } from '../src/tools/web.tools.js';
import { loadConfig, paths } from '../src/config.js';

let tmp: string;
let workdir: string;
let store: Store;
let broker: PermissionBroker;
let registry: ToolRegistry;

const ctx = { conversationId: 'conv_t', channel: 'web', signal: new AbortController().signal };

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-tools-'));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-work-'));
  process.env.IRIS_HOME = tmp;
  const keyring = new Keyring(path.join(tmp, 'k.json'));
  keyring.create('senha-mestra-forte-123!');
  store = new Store(path.join(tmp, 'iris.db'), keyring);
  broker = initBroker(store, initAudit(store), loadConfig({ reload: true }));
  initVault(store, keyring);
});

after(() => {
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
  delete process.env.IRIS_HOME;
});

beforeEach(() => {
  store.db.exec('DELETE FROM capabilities; DELETE FROM audit_log;');
  registry = new ToolRegistry();
  registry.registerAll([...fsTools, ...shellTools]);
  // Nos testes deste arquivo o foco é o comportamento das ferramentas,
  // então tudo que for pedido é liberado.
  broker.setFallbackPrompt(async () => 'uma_vez');
});

describe('resolução de caminho', () => {
  it('expande ~ e normaliza ..', () => {
    assert.equal(resolvePath('~/processos'), path.join(os.homedir(), 'processos'));
    assert.equal(resolvePath('/home/eu/a/../b'), '/home/eu/b');
  });

  it('o escopo pedido é o caminho já resolvido, não o texto cru', async () => {
    let escopo = '';
    broker.setFallbackPrompt(async (req) => {
      escopo = req.scope;
      return 'negado';
    });
    await registry.execute('ler_arquivo', { caminho: '~/../etc/passwd', linha_inicial: 1, linhas: 0 }, ctx);
    assert.ok(escopo.startsWith('/'), 'escopo precisa ser absoluto');
    assert.ok(!escopo.includes('..'), 'a travessia tem de ser resolvida antes da autorização');
  });
});

describe('material criptográfico é intocável', () => {
  it('reconhece os arquivos protegidos', () => {
    const p = paths();
    assert.ok(isProtectedPath(p.keyring));
    assert.ok(isProtectedPath(p.db));
    assert.ok(isProtectedPath('/etc/shadow'));
    assert.ok(isProtectedPath(path.join(os.homedir(), '.ssh/id_rsa')));
    assert.ok(!isProtectedPath(path.join(os.homedir(), 'processos/peticao.pdf')));
  });

  it('recusa ler o chaveiro mesmo com autorização total', async () => {
    broker.grant('arquivo.ler', '*');
    const r = await registry.execute(
      'ler_arquivo',
      { caminho: paths().keyring, linha_inicial: 1, linhas: 0 },
      ctx,
    );
    assert.ok(!r.ok);
    assert.match(r.content, /material criptográfico/);
  });

  it('recusa sobrescrever o banco mesmo com autorização total', async () => {
    broker.grant('arquivo.escrever', '*');
    const r = await registry.execute(
      'escrever_arquivo',
      { caminho: paths().db, conteudo: 'lixo', modo: 'substituir' },
      ctx,
    );
    assert.ok(!r.ok);
    assert.match(r.content, /material criptográfico/);
  });
});

describe('ferramentas de arquivo', () => {
  it('escreve, lê e acrescenta', async () => {
    const alvo = path.join(workdir, 'peticao.txt');

    const escrita = await registry.execute(
      'escrever_arquivo',
      { caminho: alvo, conteudo: 'Excelentíssimo Senhor Doutor Juiz\n', modo: 'substituir' },
      ctx,
    );
    assert.ok(escrita.ok);
    assert.match(escrita.content, /Criei/);

    const acrescimo = await registry.execute(
      'escrever_arquivo',
      { caminho: alvo, conteudo: 'Segunda linha\n', modo: 'acrescentar' },
      ctx,
    );
    assert.match(acrescimo.content, /Atualizei/);

    const leitura = await registry.execute('ler_arquivo', { caminho: alvo, linha_inicial: 1, linhas: 0 }, ctx);
    assert.ok(leitura.content.includes('Excelentíssimo'));
    assert.ok(leitura.content.includes('Segunda linha'));
  });

  it('lê faixa de linhas de arquivo grande', async () => {
    const alvo = path.join(workdir, 'grande.txt');
    fs.writeFileSync(alvo, Array.from({ length: 500 }, (_, i) => `linha ${i + 1}`).join('\n'));
    const r = await registry.execute('ler_arquivo', { caminho: alvo, linha_inicial: 10, linhas: 3 }, ctx);
    assert.match(r.content, /linhas 10–12 de 500/);
    assert.ok(r.content.includes('linha 10'));
    assert.ok(!r.content.includes('linha 14'));
  });

  it('identifica binário em vez de despejar lixo no contexto', async () => {
    const alvo = path.join(workdir, 'imagem.bin');
    fs.writeFileSync(alvo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const r = await registry.execute('ler_arquivo', { caminho: alvo, linha_inicial: 1, linhas: 0 }, ctx);
    assert.match(r.content, /binário/);
  });

  it('lista pasta e encontra arquivo por nome e conteúdo', async () => {
    const sub = path.join(workdir, 'processos', '2024');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'almeida.txt'), 'Reclamação trabalhista de João Almeida contra a Transportes Norte.');
    fs.writeFileSync(path.join(sub, 'outro.txt'), 'Assunto diferente.');

    const lista = await registry.execute(
      'listar_pasta',
      { caminho: path.join(workdir, 'processos'), recursivo: true },
      ctx,
    );
    assert.ok(lista.content.includes('almeida.txt'));

    const porNome = await registry.execute(
      'buscar_arquivos',
      { pasta: workdir, padrao: 'almeida', conteudo: '' },
      ctx,
    );
    assert.ok(porNome.content.includes('almeida.txt'));

    const porConteudo = await registry.execute(
      'buscar_arquivos',
      { pasta: workdir, padrao: '', conteudo: 'Transportes Norte' },
      ctx,
    );
    assert.ok(porConteudo.content.includes('almeida.txt'));
    assert.ok(!porConteudo.content.includes('outro.txt'));
  });

  it('apagar exige a capacidade de apagar, não a de escrever', async () => {
    const alvo = path.join(workdir, 'descartavel.txt');
    fs.writeFileSync(alvo, 'x');
    const capacidades: string[] = [];
    broker.setFallbackPrompt(async (req) => {
      capacidades.push(req.capability);
      return 'uma_vez';
    });
    await registry.execute('apagar_arquivo', { caminho: alvo }, ctx);
    assert.deepEqual(capacidades, ['arquivo.apagar']);
    assert.ok(!fs.existsSync(alvo));
  });

  it('recusa apagar pasta', async () => {
    const dir = path.join(workdir, 'uma-pasta');
    fs.mkdirSync(dir, { recursive: true });
    const r = await registry.execute('apagar_arquivo', { caminho: dir }, ctx);
    assert.ok(!r.ok);
    assert.match(r.content, /pasta inteira/);
  });
});

describe('escopo de comando', () => {
  it('sem shell, o escopo é o programa', () => {
    assert.equal(commandScope('git status --short', false), 'git');
    assert.equal(commandScope('pdftotext arquivo.pdf -', false), 'pdftotext');
    assert.equal(commandScope('LANG=C ls -la', false), 'ls');
    assert.equal(commandScope('sudo apt update', false), 'sudo');
  });

  it('com shell, o escopo é a linha inteira — a autorização não fica mais larga do que parece', () => {
    assert.equal(commandScope('cat a.txt | grep x', true), 'cat a.txt | grep x');
  });

  it('autorizar um programa não libera outro', async () => {
    broker.grant('shell.executar', 'git');
    const pedidos: string[] = [];
    broker.setFallbackPrompt(async (req) => {
      pedidos.push(req.scope);
      return 'negado';
    });
    const ok = await registry.execute(
      'executar_comando',
      { comando: 'git --version', pasta: workdir, usar_shell: false, segundos: 10 },
      ctx,
    );
    assert.equal(pedidos.length, 0, 'git já estava autorizado');
    assert.ok(ok.ok);

    await registry.execute(
      'executar_comando',
      { comando: 'curl http://exemplo.com', pasta: workdir, usar_shell: false, segundos: 10 },
      ctx,
    );
    assert.deepEqual(pedidos, ['curl'], 'curl é outro programa e precisa de autorização própria');
  });
});

describe('divisão de argumentos sem shell', () => {
  it('respeita aspas', () => {
    assert.deepEqual(splitArgs('grep -r "João Almeida" .'), ['grep', '-r', 'João Almeida', '.']);
    assert.deepEqual(splitArgs("echo 'um dois'"), ['echo', 'um dois']);
  });

  it('não interpreta pipe como operador quando o shell está desligado', () => {
    assert.deepEqual(splitArgs('echo a | b'), ['echo', 'a', '|', 'b']);
  });
});

describe('execução de comando', () => {
  it('captura a saída', async () => {
    const r = await registry.execute(
      'executar_comando',
      { comando: 'echo alô mundo', pasta: workdir, usar_shell: false, segundos: 10 },
      ctx,
    );
    assert.ok(r.ok);
    assert.match(r.content, /alô mundo/);
  });

  it('devolve o código de saída quando falha', async () => {
    const r = await registry.execute(
      'executar_comando',
      { comando: 'ls /caminho/que/nao/existe', pasta: workdir, usar_shell: false, segundos: 10 },
      ctx,
    );
    assert.ok(!r.ok);
    assert.match(r.content, /Código de saída/);
  });

  it('explica comando inexistente em vez de estourar', async () => {
    const r = await registry.execute(
      'executar_comando',
      { comando: 'programa_que_nao_existe_xyz', pasta: workdir, usar_shell: false, segundos: 10 },
      ctx,
    );
    assert.ok(!r.ok);
    assert.match(r.content, /não encontrado/);
  });

  it('interrompe comando que passa do tempo', async () => {
    const r = await registry.execute(
      'executar_comando',
      { comando: 'sleep 30', pasta: workdir, usar_shell: false, segundos: 1 },
      ctx,
    );
    assert.ok(!r.ok);
    assert.match(r.content, /passou de 1s/);
  });

  it('usa o shell quando pedido, e aí o escopo é a linha toda', async () => {
    let escopo = '';
    broker.setFallbackPrompt(async (req) => {
      escopo = req.scope;
      return 'uma_vez';
    });
    const r = await registry.execute(
      'executar_comando',
      { comando: 'echo um && echo dois', pasta: workdir, usar_shell: true, segundos: 10 },
      ctx,
    );
    assert.ok(r.ok);
    assert.match(r.content, /um[\s\S]*dois/);
    assert.equal(escopo, 'echo um && echo dois');
  });
});

describe('conversão de HTML', () => {
  it('extrai o texto e descarta script e estilo', () => {
    const html = `
      <html><head><style>body{color:red}</style><script>var x=1</script></head>
      <body><h1>Movimenta&ccedil;&atilde;o</h1><p>Processo 0001234-56</p>
      <ul><li>Senten&ccedil;a</li><li>Rec&uacute;rso</li></ul></body></html>`;
    const texto = htmlToText(html);
    assert.ok(!texto.includes('var x'));
    assert.ok(!texto.includes('color:red'));
    assert.ok(texto.includes('Processo 0001234-56'));
    assert.ok(texto.includes('•'));
  });

  it('decodifica entidades numéricas e não deixa tag sobrando', () => {
    const texto = htmlToText('<p>Tr&#234;s &amp; quatro &lt;ok&gt;</p>');
    assert.ok(texto.includes('Três & quatro <ok>'));
    assert.ok(!/[<>]\w/.test(texto.replace('<ok>', '')));
  });
});
