/**
 * Contrato do canal WhatsApp.
 *
 * Existem dois caminhos para levar o Gideão ao WhatsApp, e eles têm implicações
 * bem diferentes:
 *
 *  - **Cloud API (oficial, da Meta)** — o caminho suportado. Exige um número
 *    dedicado cadastrado como conta business, e esse número **não pode ser o
 *    mesmo** que você já usa no WhatsApp do celular. Em troca: estável,
 *    dentro dos termos, sem risco de bloqueio.
 *
 *  - **Baileys (não oficial)** — conecta o seu número pessoal lendo o QR, como
 *    o WhatsApp Web faz. É o que a maioria quer, porque usa o número que já
 *    existe. Mas é engenharia reversa do protocolo: viola os termos de uso da
 *    Meta e **o número pode ser banido**, temporária ou definitivamente. Fica
 *    disponível aqui porque a escolha é sua, mas atrás de um aviso explícito.
 *
 * O núcleo não sabe qual dos dois está em uso: os dois implementam esta mesma
 * interface.
 */

export interface MidiaRecebida {
  /** Id da mídia no provedor, para baixar depois. */
  id: string;
  mime: string;
  nome: string;
}

export interface MensagemRecebida {
  /** Número do remetente em E.164 sem '+'. */
  de: string;
  texto: string;
  /** Id da mensagem no provedor, para deduplicação. */
  id: string;
  em: number;
  tipo: 'texto' | 'audio' | 'imagem' | 'documento' | 'outro';
  /** Foto ou PDF que veio junto — baixado sob demanda pelo provedor. */
  midia?: MidiaRecebida;
}

export interface WhatsAppProvider {
  readonly nome: string;
  /** Baixa uma mídia recebida. Nem todo provedor consegue. */
  baixarMidia?(midia: MidiaRecebida): Promise<Buffer | null>;
  /** Sobe o provedor. Pode pedir QR (Baileys) ou apenas validar credenciais. */
  iniciar(): Promise<void>;
  parar(): Promise<void>;
  enviar(para: string, texto: string): Promise<void>;
  /** Registra quem trata as mensagens que chegam. */
  aoReceber(handler: (msg: MensagemRecebida) => void | Promise<void>): void;
  readonly pronto: boolean;
}

/**
 * Corta uma resposta longa no limite do WhatsApp (4096 caracteres), quebrando
 * em parágrafo ou frase em vez de no meio de uma palavra.
 */
export function dividirMensagem(texto: string, limite = 3800): string[] {
  if (texto.length <= limite) return [texto];

  const partes: string[] = [];
  let resto = texto;

  while (resto.length > limite) {
    let corte = resto.lastIndexOf('\n\n', limite);
    if (corte < limite * 0.5) corte = resto.lastIndexOf('\n', limite);
    if (corte < limite * 0.5) corte = resto.lastIndexOf('. ', limite);
    if (corte < limite * 0.5) corte = resto.lastIndexOf(' ', limite);
    if (corte < limite * 0.5) corte = limite;

    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);

  // Numera quando há mais de uma parte, para a ordem ficar clara no celular.
  return partes.length > 1 ? partes.map((p, i) => `(${i + 1}/${partes.length}) ${p}`) : partes;
}

/** Normaliza para E.164 sem '+', tolerando o que a pessoa digitou. */
export function normalizarNumero(numero: string): string {
  const limpo = numero.replace(/\D/g, '');
  // Brasil sem o código do país: assume 55.
  if (limpo.length === 10 || limpo.length === 11) return `55${limpo}`;
  return limpo;
}

/**
 * Compara dois números tolerando o nono dígito.
 *
 * O WhatsApp entrega números de celular brasileiros ora com o 9 na frente do
 * número, ora sem — depende de quando a linha foi cadastrada. Comparar as
 * strings direto faria a lista do dono falhar de forma intermitente, que é a
 * pior falha possível num controle de acesso.
 */
export function mesmoNumero(a: string, b: string): boolean {
  const x = normalizarNumero(a);
  const y = normalizarNumero(b);
  if (x === y) return true;

  const semNove = (n: string) =>
    /^55\d{2}9\d{8}$/.test(n) ? `55${n.slice(2, 4)}${n.slice(5)}` : n;
  return semNove(x) === semNove(y);
}
