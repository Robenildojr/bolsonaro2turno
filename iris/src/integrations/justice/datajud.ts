/**
 * DataJud — a base pública de processos do CNJ.
 *
 * É a fonte certa para acompanhar andamento: pública, documentada, sem CAPTCHA
 * e sem certificado. O que ela **não** tem: peças, documentos e processos em
 * segredo de justiça. Para isso continua sendo necessário entrar no sistema do
 * tribunal com as suas credenciais — é o que as ferramentas de navegador fazem.
 *
 * A chave pública é divulgada pelo próprio CNJ na documentação da API.
 * Referência: https://datajud-wiki.cnj.jus.br/api-publica/
 */
import { createLogger } from '../../util/logger.js';

const log = createLogger('datajud');

const BASE = 'https://api-publica.datajud.cnj.jus.br';

/**
 * Chave pública divulgada pelo CNJ. Se a API começar a recusar, é porque o CNJ
 * rotacionou a chave — basta pegar a nova na wiki e pôr em DATAJUD_API_KEY.
 */
const CHAVE_PUBLICA_CNJ =
  'cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==';

export interface Movimento {
  codigo: number;
  nome: string;
  data: string;
  complementos: string[];
}

export interface ProcessoDataJud {
  numero: string;
  tribunal: string;
  classe: string;
  assuntos: string[];
  orgaoJulgador: string;
  grau: string;
  ajuizamento: string;
  ultimaAtualizacao: string;
  movimentos: Movimento[];
}

/** Só dígitos: 20 posições no padrão CNJ. */
export function limparNumero(numero: string): string {
  return numero.replace(/\D/g, '');
}

export function formatarNumero(numero: string): string {
  const n = limparNumero(numero);
  if (n.length !== 20) return numero;
  return `${n.slice(0, 7)}-${n.slice(7, 9)}.${n.slice(9, 13)}.${n.slice(13, 14)}.${n.slice(14, 16)}.${n.slice(16)}`;
}

/** Códigos de tribunal estadual (posições 15-16 do número CNJ) por UF. */
const TJ_POR_CODIGO: Record<string, string> = {
  '01': 'ac', '02': 'al', '03': 'ap', '04': 'am', '05': 'ba', '06': 'ce',
  '07': 'df', '08': 'es', '09': 'go', '10': 'ma', '11': 'mt', '12': 'ms',
  '13': 'mg', '14': 'pa', '15': 'pb', '16': 'pr', '17': 'pe', '18': 'pi',
  '19': 'rj', '20': 'rn', '21': 'rs', '22': 'ro', '23': 'rr', '24': 'sc',
  '25': 'se', '26': 'sp', '27': 'to',
};

/**
 * Deriva o endpoint a partir do número CNJ.
 *
 * Formato: NNNNNNN-DD.AAAA.J.TR.OOOO
 *   J  = segmento do judiciário  (4 federal, 5 trabalho, 6 eleitoral, 8 estadual…)
 *   TR = tribunal dentro do segmento
 */
export function aliasDoTribunal(numero: string): string | null {
  const n = limparNumero(numero);
  if (n.length !== 20) return null;

  const segmento = n.slice(13, 14);
  const tribunal = n.slice(14, 16);

  switch (segmento) {
    case '1':
      return 'api_publica_stf';
    case '3':
      return 'api_publica_stj';
    case '4':
      return `api_publica_trf${Number(tribunal)}`;
    case '5':
      return `api_publica_trt${Number(tribunal)}`;
    case '6':
      return `api_publica_tre-${TJ_POR_CODIGO[tribunal] ?? tribunal}`;
    case '7':
      return 'api_publica_stm';
    case '8': {
      const uf = TJ_POR_CODIGO[tribunal];
      return uf ? `api_publica_tj${uf}` : null;
    }
    case '9':
      return `api_publica_tjm${TJ_POR_CODIGO[tribunal] ?? tribunal}`;
    default:
      return null;
  }
}

export class DataJud {
  constructor(private readonly apiKey: string = process.env.DATAJUD_API_KEY || CHAVE_PUBLICA_CNJ) {}

  /** Consulta um processo pelo número CNJ. */
  async consultar(numero: string): Promise<ProcessoDataJud | null> {
    const alias = aliasDoTribunal(numero);
    if (!alias) {
      throw new Error(
        `não consegui identificar o tribunal a partir do número "${numero}". ` +
          'Confira se ele está completo, no padrão CNJ de 20 dígitos.',
      );
    }

    const corpo = {
      size: 1,
      query: { match: { numeroProcesso: limparNumero(numero) } },
    };

    const res = await fetch(`${BASE}/${alias}/_search`, {
      method: 'POST',
      headers: {
        authorization: `APIKey ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(45_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'o DataJud recusou a chave de acesso. O CNJ rotaciona a chave pública de tempos em ' +
          'tempos: pegue a atual em datajud-wiki.cnj.jus.br/api-publica e ponha em DATAJUD_API_KEY.',
      );
    }
    if (res.status === 404) {
      throw new Error(`o tribunal "${alias}" não existe na API do DataJud`);
    }
    if (!res.ok) {
      throw new Error(`DataJud respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      hits?: { hits?: Array<{ _source?: Record<string, unknown> }> };
    };
    const fonte = json.hits?.hits?.[0]?._source;
    if (!fonte) {
      log.info('processo não encontrado no DataJud', { numero: formatarNumero(numero), alias });
      return null;
    }

    return converter(fonte, alias);
  }

  /**
   * Busca por classe e órgão julgador.
   *
   * O DataJud **não indexa o nome das partes** — é uma base de metadados
   * processuais, não um buscador de pessoas. Para achar o processo de um
   * cliente pelo nome, o caminho é o sistema do tribunal, autenticado.
   */
  async buscarPorOrgao(
    alias: string,
    orgaoJulgador: string,
    limite = 20,
  ): Promise<ProcessoDataJud[]> {
    const res = await fetch(`${BASE}/${alias}/_search`, {
      method: 'POST',
      headers: {
        authorization: `APIKey ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        size: limite,
        query: { match: { 'orgaoJulgador.nome': orgaoJulgador } },
        sort: [{ '@timestamp': { order: 'desc' } }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) throw new Error(`DataJud respondeu ${res.status}`);
    const json = (await res.json()) as {
      hits?: { hits?: Array<{ _source?: Record<string, unknown> }> };
    };
    return (json.hits?.hits ?? [])
      .map((h) => (h._source ? converter(h._source, alias) : null))
      .filter((p): p is ProcessoDataJud => p !== null);
  }
}

function converter(fonte: Record<string, unknown>, alias: string): ProcessoDataJud {
  const movimentos = Array.isArray(fonte.movimentos)
    ? (fonte.movimentos as Array<Record<string, unknown>>)
        .map((m) => ({
          codigo: Number(m.codigo) || 0,
          nome: String(m.nome ?? ''),
          data: String(m.dataHora ?? ''),
          complementos: Array.isArray(m.complementosTabelados)
            ? (m.complementosTabelados as Array<Record<string, unknown>>).map((c) =>
                String(c.nome ?? c.descricao ?? ''),
              )
            : [],
        }))
        .sort((a, b) => b.data.localeCompare(a.data))
    : [];

  const orgao = fonte.orgaoJulgador as Record<string, unknown> | undefined;
  const classe = fonte.classe as Record<string, unknown> | undefined;

  return {
    numero: formatarNumero(String(fonte.numeroProcesso ?? '')),
    tribunal: String(fonte.tribunal ?? alias.replace('api_publica_', '').toUpperCase()),
    classe: String(classe?.nome ?? ''),
    assuntos: Array.isArray(fonte.assuntos)
      ? (fonte.assuntos as Array<Record<string, unknown>>).map((a) => String(a.nome ?? ''))
      : [],
    orgaoJulgador: String(orgao?.nome ?? ''),
    grau: String(fonte.grau ?? ''),
    ajuizamento: String(fonte.dataAjuizamento ?? ''),
    ultimaAtualizacao: String(fonte.dataHoraUltimaAtualizacao ?? ''),
    movimentos,
  };
}

/** Texto legível de um processo, para o modelo e para o dono. */
export function descreverProcesso(p: ProcessoDataJud, maxMovimentos = 15): string {
  const linhas = [
    `Processo ${p.numero} — ${p.tribunal}${p.grau ? ` (${p.grau})` : ''}`,
    p.classe && `Classe: ${p.classe}`,
    p.assuntos.length > 0 && `Assunto: ${p.assuntos.join('; ')}`,
    p.orgaoJulgador && `Órgão: ${p.orgaoJulgador}`,
    p.ajuizamento && `Ajuizado em: ${p.ajuizamento.slice(0, 10)}`,
    p.ultimaAtualizacao && `Última atualização na base: ${p.ultimaAtualizacao.slice(0, 10)}`,
  ].filter(Boolean);

  if (p.movimentos.length > 0) {
    linhas.push('', `Movimentações (${p.movimentos.length} no total, mostrando as mais recentes):`);
    for (const m of p.movimentos.slice(0, maxMovimentos)) {
      const complemento = m.complementos.length > 0 ? ` — ${m.complementos.join(', ')}` : '';
      linhas.push(`- ${m.data.slice(0, 10)}: ${m.nome}${complemento}`);
    }
  } else {
    linhas.push('', 'Sem movimentações registradas na base pública.');
  }

  return linhas.join('\n');
}

/** Impressão digital do estado do processo, para detectar novidade. */
export function hashDoEstado(p: ProcessoDataJud): string {
  const ultimo = p.movimentos[0];
  return `${p.movimentos.length}:${ultimo?.data ?? ''}:${ultimo?.codigo ?? ''}`;
}

/**
 * Procura uma data de audiência no texto de uma movimentação.
 *
 * O DataJud não traz campo de audiência: a informação, quando existe, está no
 * nome do movimento ou no complemento. É heurística, então o que ela produz
 * vira lembrete "a confirmar", nunca certeza.
 */
export function extrairAudiencia(movimento: Movimento): { data: Date; texto: string } | null {
  const texto = `${movimento.nome} ${movimento.complementos.join(' ')}`;
  if (!/audi[êe]ncia|sess[ãa]o de julgamento|peric[ií]a/i.test(texto)) return null;

  const m = /(\d{2})[/-](\d{2})[/-](\d{4})(?:[^\d]{1,12}(\d{1,2})[:h](\d{2}))?/.exec(texto);
  if (!m) return null;

  const [, dia, mes, ano, hora, minuto] = m;
  const data = new Date(
    Number(ano),
    Number(mes) - 1,
    Number(dia),
    hora ? Number(hora) : 9,
    minuto ? Number(minuto) : 0,
  );
  if (Number.isNaN(data.getTime()) || data.getTime() < Date.now()) return null;
  return { data, texto: texto.trim() };
}
