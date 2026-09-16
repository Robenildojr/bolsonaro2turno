/**
 * Versão nova do próprio código.
 *
 * O dono pediu que o Gideão se mantenha atualizado sozinho, "que ele busque
 * ferramentas, informações na internet e se atualize automaticamente". Este
 * módulo faz a parte do código — e faz de um jeito específico, que vale
 * explicar porque a diferença entre os dois caminhos é grande:
 *
 *   **o que ele faz:** confere se o repositório tem commit novo, lê o que
 *   mudou, avisa, e — quando autorizado — aplica, instala as dependências e
 *   roda a bateria de testes. Se os testes falharem, ele **volta sozinho** para
 *   onde estava.
 *
 *   **o que ele não faz:** baixar código da internet e executar sem
 *   autorização. Isso não é excesso de cautela: a revisão de segurança da etapa
 *   14 fechou seis buracos e o tema de todos era o mesmo — o portão concordava
 *   com uma coisa e o código executava outra. Um agente que atualiza a si mesmo
 *   sem pedir é esse buraco na forma mais pura possível, porque quem controlar
 *   a origem do código controla a máquina inteira. O repositório é do dono; a
 *   decisão de puxar de lá também é.
 *
 * Nada aqui passa por shell: `execFile` com argumentos em vetor, sempre.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLogger, describeError } from '../../util/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('atualizacao:codigo');

/** Raiz do repositório: dois níveis acima de src/core/updates. */
export function raizDoProjeto(): string {
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(aqui, '../../..');
}

async function git(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: raizDoProjeto(),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

export interface EstadoDoCodigo {
  /** Verdadeiro quando o diretório é mesmo um repositório git. */
  repositorio: boolean;
  ramo: string;
  atual: string;
  /** Commits que existem no remoto e não aqui. */
  pendentes: Array<{ hash: string; assunto: string }>;
  /** Alterações locais não commitadas — impedem a aplicação automática. */
  sujo: boolean;
  erro?: string;
}

export async function verificar(): Promise<EstadoDoCodigo> {
  const vazio: EstadoDoCodigo = {
    repositorio: false,
    ramo: '',
    atual: '',
    pendentes: [],
    sujo: false,
  };

  try {
    await git(['rev-parse', '--git-dir'], 10_000);
  } catch {
    return { ...vazio, erro: 'esta cópia não é um repositório git — atualize manualmente' };
  }

  try {
    const ramo = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
    const atual = await git(['rev-parse', '--short', 'HEAD'], 10_000);
    const sujo = (await git(['status', '--porcelain'], 15_000)).length > 0;

    await git(['fetch', 'origin', ramo], 90_000);
    const bruto = await git(['log', '--oneline', `HEAD..origin/${ramo}`], 20_000);

    const pendentes = bruto
      .split('\n')
      .filter(Boolean)
      .map((linha) => {
        const [hash, ...resto] = linha.split(' ');
        return { hash: hash ?? '', assunto: resto.join(' ') };
      });

    return { repositorio: true, ramo, atual, pendentes, sujo };
  } catch (err) {
    return { ...vazio, repositorio: true, erro: describeError(err) };
  }
}

export interface ResultadoAplicacao {
  ok: boolean;
  mensagem: string;
  revertido?: boolean;
  de?: string;
  para?: string;
}

/**
 * Aplica a versão nova, com rede de proteção.
 *
 * A ordem importa: guarda onde estava, puxa, instala, testa. Teste vermelho
 * desfaz tudo — porque um assistente que se atualiza para uma versão quebrada
 * fica sem conseguir nem contar o que aconteceu.
 *
 * Quem chama é responsável por ter pedido autorização antes. Esta função não
 * abre o portão sozinha.
 */
export async function aplicar(): Promise<ResultadoAplicacao> {
  const antes = await verificar();

  if (antes.erro) return { ok: false, mensagem: antes.erro };
  if (!antes.pendentes.length) return { ok: true, mensagem: 'já estou na versão mais recente' };
  if (antes.sujo) {
    return {
      ok: false,
      mensagem:
        'há alterações locais não salvas no repositório. Não vou puxar por cima delas — ' +
        'resolva com `git status` e peça de novo.',
    };
  }

  const origem = antes.atual;
  try {
    // --ff-only: se divergiu, para em vez de criar merge sozinho.
    await git(['pull', '--ff-only', 'origin', antes.ramo], 180_000);
    const destino = await git(['rev-parse', '--short', 'HEAD'], 10_000);

    log.info('código atualizado, instalando dependências', { de: origem, para: destino });
    await execFileAsync('npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: raizDoProjeto(),
      timeout: 600_000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    log.info('rodando os testes antes de assumir a versão nova');
    await execFileAsync('npm', ['test'], {
      cwd: raizDoProjeto(),
      timeout: 600_000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    return {
      ok: true,
      de: origem,
      para: destino,
      mensagem:
        `Atualizei de ${origem} para ${destino} e os testes passaram. ` +
        'Precisa reiniciar (`npm run build && npm start`) para a versão nova entrar no ar.',
    };
  } catch (err) {
    const motivo = describeError(err);
    try {
      await git(['reset', '--hard', origem], 60_000);
      log.warn('atualização revertida', { de: origem, motivo });
      return {
        ok: false,
        revertido: true,
        mensagem:
          `A versão nova não passou nos testes, então voltei para ${origem}. ` +
          `Continua tudo funcionando como antes. Motivo: ${motivo}`,
      };
    } catch (erroReversao) {
      return {
        ok: false,
        revertido: false,
        mensagem:
          `A atualização falhou (${motivo}) e a volta atrás também ` +
          `(${describeError(erroReversao)}). Isso precisa de você: rode ` +
          `\`git reset --hard ${origem}\` na pasta do projeto.`,
      };
    }
  }
}
