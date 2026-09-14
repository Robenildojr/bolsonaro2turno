/**
 * Redação de segredos. Tudo que sai para log, telemetria ou trilha de auditoria
 * passa por aqui. A regra é simples: é melhor redigir demais do que vazar uma
 * senha do PJe num arquivo de log.
 */

const SECRET_KEYS =
  /^(pass(word|phrase)?|senha|secret|token|api[_-]?key|authorization|auth|cookie|session|refresh_token|access_token|private_key|otp|pin|cpf|cnpj|credential[s]?)$/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_\-]{16,}/g, 'sk-ant-***'],
  [/\bsk-[A-Za-z0-9_\-]{20,}/g, 'sk-***'],
  [/\bEAA[A-Za-z0-9]{20,}/g, 'EAA***'],                // tokens da Graph API (WhatsApp)
  [/\bya29\.[A-Za-z0-9_\-]{20,}/g, 'ya29.***'],        // tokens OAuth do Google
  [/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_***'],
  [/\bAIza[A-Za-z0-9_\-]{20,}/g, 'AIza***'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '<chave-privada-redigida>',
  ],
  // Cartão de crédito em grupos de quatro. Números de processo do CNJ usam
  // pontos e não batem com este padrão, então continuam legíveis no log.
  [/\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g, '<possível-cartão-redigido>'],
];

/** Mascara uma string solta. */
export function redactText(input: string): string {
  let out = input;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Mascara recursivamente um objeto, sem alterar o original. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<profundo-demais>';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}b>`;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = typeof v === 'string' && v.length > 0 ? `<${k} redigido:${v.length}>` : '<redigido>';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Corta uma string longa mantendo o começo e o fim — útil em logs. */
export function clip(text: string, max = 600): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n… [${text.length - head.length - tail.length} caracteres omitidos] …\n${tail}`;
}
