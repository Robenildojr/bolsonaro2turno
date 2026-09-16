/**
 * O que pode ser ajustado, e por onde.
 *
 * Esta lista é a **fronteira**. Três coisas diferentes escrevem na configuração
 * — o painel da engrenagem, a ferramenta que o Gideão usa quando você pede um
 * ajuste na conversa, e a CLI — e todas as três passam por aqui. Uma chave que
 * não está nesta lista não é alterável por nenhuma delas.
 *
 * Isso não é burocracia. A configuração guarda `ANTHROPIC_API_KEY` não, mas
 * guarda o token de acesso do servidor, o segredo do app do WhatsApp e as
 * credenciais do Drive. Se o caminho fosse "escreva qualquer chave em
 * config.json", bastaria convencer o modelo a "ajustar uma configuração" para
 * ele reescrever `server.accessToken` — e quem soubesse o valor novo entraria
 * na interface. Com a lista, o pior que um pedido mal-intencionado consegue é
 * mudar a cor do orbe.
 *
 * O que fica **de fora**, de propósito: qualquer chave/segredo/token, o número
 * do dono no WhatsApp (é o controle de acesso do canal), o diretório de dados,
 * e ligar o observador — este último só desliga por aqui; ligar exige o
 * consentimento explícito descrito em docs/OBSERVADOR.md.
 */
import { loadConfig, saveConfig, type Config } from '../../config.js';

export type TipoAjuste = 'texto' | 'booleano' | 'numero' | 'escolha' | 'lista';

export interface Ajuste {
  /** Caminho pontilhado dentro da configuração, ex.: `voice.velocidade`. */
  chave: string;
  rotulo: string;
  ajuda: string;
  tipo: TipoAjuste;
  grupo: string;
  opcoes?: Array<{ valor: string; rotulo: string }>;
  min?: number;
  max?: number;
  passo?: number;
  /** Só vale depois de reiniciar (`npm start`). */
  reiniciar?: boolean;
  /** Pode ser desligado por aqui, mas não ligado. */
  somenteDesligar?: boolean;
  /** Fora do alcance da conversa — só pela engrenagem ou pela CLI. */
  somenteInterface?: boolean;
}

export const AJUSTES: Ajuste[] = [
  // ── quem é quem ────────────────────────────────────────────────────────────
  {
    chave: 'assistantName',
    rotulo: 'Nome dele',
    ajuda: 'Como ele se apresenta e como você o chama.',
    tipo: 'texto',
    grupo: 'Identidade',
  },
  {
    chave: 'ownerName',
    rotulo: 'Seu nome',
    ajuda: 'Como ele se dirige a você.',
    tipo: 'texto',
    grupo: 'Identidade',
  },
  {
    chave: 'timezone',
    rotulo: 'Fuso horário',
    ajuda: 'Base de todo prazo, audiência e lembrete. Amapá e Pará: America/Belem.',
    tipo: 'texto',
    grupo: 'Identidade',
  },

  // ── voz ────────────────────────────────────────────────────────────────────
  {
    chave: 'voice.nome',
    rotulo: 'Voz',
    ajuda: 'Vazio deixa ele escolher sozinho uma voz masculina em português.',
    tipo: 'escolha',
    grupo: 'Voz',
    opcoes: [],
  },
  {
    chave: 'voice.velocidade',
    rotulo: 'Velocidade da fala',
    ajuda: '1,0 é o normal do navegador. Acima de 1,3 fica difícil de acompanhar.',
    tipo: 'numero',
    min: 0.6,
    max: 1.6,
    passo: 0.02,
    grupo: 'Voz',
  },
  {
    chave: 'voice.tom',
    rotulo: 'Tom da voz',
    ajuda: 'Abaixo de 1,0 deixa a voz mais grave.',
    tipo: 'numero',
    min: 0.5,
    max: 1.5,
    passo: 0.02,
    grupo: 'Voz',
  },
  {
    chave: 'voice.falarAuto',
    rotulo: 'Falar as respostas em voz alta',
    ajuda: 'Desligado, ele só escreve. Você ainda pode mandar ler quando quiser.',
    tipo: 'booleano',
    grupo: 'Voz',
  },

  {
    chave: 'voice.escutaContinua',
    rotulo: 'Escutar sempre, sem clicar',
    ajuda:
      'O microfone fica aberto e basta chamar pelo nome. ATENÇÃO: enquanto ligado, TODO o áudio captado vai para os servidores do navegador (Google no Chrome, Microsoft no Edge) — inclusive conversa de cliente. Desligue antes de tratar assunto sigiloso.',
    tipo: 'booleano',
    grupo: 'Voz',
    somenteInterface: true,
  },
  {
    chave: 'voice.palavraChave',
    rotulo: 'Como chamar ele',
    ajuda: 'A palavra que acorda ele. Variações de pronúncia são toleradas.',
    tipo: 'texto',
    grupo: 'Voz',
  },
  {
    chave: 'voice.minutosOciosos',
    rotulo: 'Fechar o microfone depois de',
    ajuda: 'Minutos sem ser chamado até a escuta se desligar sozinha.',
    tipo: 'numero',
    min: 5,
    max: 240,
    passo: 5,
    grupo: 'Voz',
  },

  // ── tela ───────────────────────────────────────────────────────────────────
  {
    chave: 'ui.legendas',
    rotulo: 'Legenda embaixo do orbe',
    ajuda: 'A fala dele em texto grande, como legenda de filme.',
    tipo: 'booleano',
    grupo: 'Tela',
  },
  {
    chave: 'ui.matiz',
    rotulo: 'Cor do orbe',
    ajuda: 'Matiz de 0 a 360. 258 é o violeta padrão.',
    tipo: 'numero',
    min: 0,
    max: 360,
    passo: 1,
    grupo: 'Tela',
  },

  // ── como ele pensa ─────────────────────────────────────────────────────────
  {
    chave: 'model.effort',
    rotulo: 'Esforço de raciocínio',
    ajuda: 'Mais esforço pensa melhor e custa mais. "high" resolve quase tudo.',
    tipo: 'escolha',
    grupo: 'Raciocínio',
    opcoes: [
      { valor: 'low', rotulo: 'baixo — rápido e barato' },
      { valor: 'medium', rotulo: 'médio' },
      { valor: 'high', rotulo: 'alto (recomendado)' },
      { valor: 'xhigh', rotulo: 'muito alto' },
      { valor: 'max', rotulo: 'máximo — para quando errar sai caro' },
    ],
  },

  // ── segurança ──────────────────────────────────────────────────────────────
  {
    chave: 'permissions.confirmCritical',
    rotulo: 'Confirmar ações irreversíveis',
    ajuda:
      'Mesmo autorizado, ele confirma antes de apagar em massa, formatar ou mandar mensagem a terceiro. Desligar isso é decisão sua — leia docs/PERMISSOES.md antes.',
    tipo: 'booleano',
    grupo: 'Segurança',
    somenteInterface: true,
  },
  {
    chave: 'permissions.requestTimeoutSec',
    rotulo: 'Prazo para responder a um pedido',
    ajuda: 'Sem resposta nesse tempo, o pedido é negado. Silêncio nunca vira sim.',
    tipo: 'numero',
    min: 30,
    max: 3600,
    passo: 30,
    grupo: 'Segurança',
    somenteInterface: true,
  },
  {
    chave: 'observer.enabled',
    rotulo: 'Observador de contexto',
    ajuda:
      'Captura o que você copia e em que janela trabalha. Daqui só dá para DESLIGAR: ligar exige o consentimento explícito, pela conversa ou pela CLI.',
    tipo: 'booleano',
    grupo: 'Segurança',
    somenteDesligar: true,
    somenteInterface: true,
  },

  // ── atualização ────────────────────────────────────────────────────────────
  {
    chave: 'updates.conhecimento',
    rotulo: 'Estudar sozinho',
    ajuda: 'Todo dia de madrugada ele pesquisa os temas abaixo e guarda o que mudou.',
    tipo: 'booleano',
    grupo: 'Atualização',
  },
  {
    chave: 'updates.temas',
    rotulo: 'Temas que ele acompanha',
    ajuda: 'Um por linha. É o que ele vai pesquisar sozinho.',
    tipo: 'lista',
    grupo: 'Atualização',
  },
  {
    chave: 'updates.codigo',
    rotulo: 'Avisar quando houver versão nova',
    ajuda: 'Ele confere o repositório e te avisa. Aplicar continua sendo decisão sua.',
    tipo: 'booleano',
    grupo: 'Atualização',
  },
  {
    chave: 'updates.modelo',
    rotulo: 'Avisar quando sair modelo melhor',
    ajuda: 'Confere na Anthropic se existe modelo mais novo que o que ele usa hoje.',
    tipo: 'booleano',
    grupo: 'Atualização',
  },
  {
    chave: 'model.main',
    rotulo: 'Modelo em uso',
    ajuda: 'Trocar por um modelo que não existe deixa ele mudo. Confira o nome antes.',
    tipo: 'texto',
    grupo: 'Atualização',
    reiniciar: true,
    somenteInterface: true,
  },
];

const PORCHAVE = new Map(AJUSTES.map((a) => [a.chave, a]));

/** Lê um caminho pontilhado de dentro de um objeto. */
function ler(obj: unknown, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((atual, parte) => {
    if (atual && typeof atual === 'object') return (atual as Record<string, unknown>)[parte];
    return undefined;
  }, obj);
}

/** Monta `{a: {b: valor}}` a partir de `'a.b'`, para o merge do saveConfig. */
function aninhar(caminho: string, valor: unknown): Record<string, unknown> {
  const partes = caminho.split('.');
  const raiz: Record<string, unknown> = {};
  let atual = raiz;
  partes.forEach((parte, i) => {
    if (i === partes.length - 1) atual[parte] = valor;
    else atual = (atual[parte] = {}) as Record<string, unknown>;
  });
  return raiz;
}

export interface AjusteAtual extends Ajuste {
  valor: unknown;
}

/** Os ajustes com os valores de agora, para montar a tela ou responder na conversa. */
export function lerAjustes(cfg: Config = loadConfig()): AjusteAtual[] {
  return AJUSTES.map((a) => ({ ...a, valor: ler(cfg, a.chave) }));
}

export interface ResultadoAjuste {
  aplicados: Array<{ chave: string; de: unknown; para: unknown }>;
  recusados: Array<{ chave: string; motivo: string }>;
  precisaReiniciar: boolean;
}

/**
 * Valida e grava. Devolve o que entrou e o que foi recusado, com o motivo —
 * um ajuste silenciosamente ignorado é pior que um recusado com explicação.
 *
 * `origem` muda o que é permitido: pela conversa, os ajustes marcados
 * `somenteInterface` não passam. A diferença existe porque mudar o prazo de
 * uma autorização ou desligar a confirmação de ação irreversível são decisões
 * sobre os próprios freios — e essas ficam na mão do dono, na tela, não numa
 * frase que ele pode ter dito de passagem.
 */
export function aplicarAjustes(
  patch: Record<string, unknown>,
  origem: 'interface' | 'conversa' = 'interface',
): ResultadoAjuste {
  const cfg = loadConfig();
  const aplicados: ResultadoAjuste['aplicados'] = [];
  const recusados: ResultadoAjuste['recusados'] = [];
  let mudancas: Record<string, unknown> = {};
  let precisaReiniciar = false;

  for (const [chave, bruto] of Object.entries(patch)) {
    const ajuste = PORCHAVE.get(chave);
    if (!ajuste) {
      recusados.push({ chave, motivo: 'não é um ajuste que eu possa mudar' });
      continue;
    }
    if (origem === 'conversa' && ajuste.somenteInterface) {
      recusados.push({
        chave,
        motivo: 'este só pela engrenagem na tela ou pela linha de comando',
      });
      continue;
    }

    const atual = ler(cfg, chave);
    const valor = converter(ajuste, bruto);
    if (valor instanceof Error) {
      recusados.push({ chave, motivo: valor.message });
      continue;
    }
    if (ajuste.somenteDesligar && valor === true && atual !== true) {
      recusados.push({ chave, motivo: 'daqui só dá para desligar — ligar exige autorização' });
      continue;
    }
    if (JSON.stringify(atual) === JSON.stringify(valor)) continue; // já estava assim

    mudancas = deepMergeSimples(mudancas, aninhar(chave, valor));
    aplicados.push({ chave, de: atual, para: valor });
    if (ajuste.reiniciar) precisaReiniciar = true;
  }

  if (aplicados.length) saveConfig(mudancas);
  return { aplicados, recusados, precisaReiniciar };
}

/** Converte e valida um valor para o tipo declarado. Devolve Error se não der. */
function converter(ajuste: Ajuste, bruto: unknown): unknown | Error {
  switch (ajuste.tipo) {
    case 'booleano': {
      if (typeof bruto === 'boolean') return bruto;
      const t = String(bruto).toLowerCase();
      if (['true', 'sim', '1', 'ligado', 'on'].includes(t)) return true;
      if (['false', 'não', 'nao', '0', 'desligado', 'off'].includes(t)) return false;
      return new Error('precisa ser sim ou não');
    }
    case 'numero': {
      const n = typeof bruto === 'number' ? bruto : Number(String(bruto).replace(',', '.'));
      if (!Number.isFinite(n)) return new Error('precisa ser um número');
      if (ajuste.min !== undefined && n < ajuste.min) {
        return new Error(`o mínimo é ${ajuste.min}`);
      }
      if (ajuste.max !== undefined && n > ajuste.max) {
        return new Error(`o máximo é ${ajuste.max}`);
      }
      return n;
    }
    case 'escolha': {
      const v = String(bruto);
      // Sem opções declaradas (a lista de vozes depende do navegador), aceita texto.
      if (!ajuste.opcoes?.length) return v;
      if (!ajuste.opcoes.some((o) => o.valor === v)) {
        return new Error(`só aceito: ${ajuste.opcoes.map((o) => o.valor).join(', ')}`);
      }
      return v;
    }
    case 'lista': {
      if (Array.isArray(bruto)) return bruto.map((x) => String(x).trim()).filter(Boolean);
      return String(bruto)
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    default: {
      const v = String(bruto).trim();
      if (!v) return new Error('não pode ficar vazio');
      if (v.length > 400) return new Error('texto longo demais');
      return v;
    }
  }
}

function deepMergeSimples(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const saida: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const atual = saida[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && atual && typeof atual === 'object') {
      saida[k] = deepMergeSimples(atual as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      saida[k] = v;
    }
  }
  return saida;
}

/** Texto curto do que mudou, para o Gideão confirmar na conversa. */
export function descreverResultado(r: ResultadoAjuste): string {
  const partes: string[] = [];
  for (const a of r.aplicados) {
    partes.push(`${PORCHAVE.get(a.chave)?.rotulo ?? a.chave}: ${mostrar(a.de)} → ${mostrar(a.para)}`);
  }
  for (const n of r.recusados) {
    partes.push(`${n.chave}: não mudou — ${n.motivo}`);
  }
  if (r.precisaReiniciar) partes.push('(essa última só vale depois de reiniciar)');
  return partes.join('\n') || 'nada mudou — já estava assim';
}

function mostrar(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'ligado' : 'desligado';
  if (Array.isArray(v)) return `${v.length} item(ns)`;
  if (v === '' || v === undefined || v === null) return '(vazio)';
  return String(v);
}
