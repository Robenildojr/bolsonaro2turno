import { onlyDigits } from "./cpf";

/** CNJ process number format: NNNNNNN-DD.AAAA.J.TR.OOOO (20 digits). */
export function maskCnj(value: string): string {
  const digits = onlyDigits(value).slice(0, 20);

  const seq = digits.slice(0, 7);
  const dv = digits.slice(7, 9);
  const ano = digits.slice(9, 13);
  const jus = digits.slice(13, 14);
  const trib = digits.slice(14, 16);
  const origem = digits.slice(16, 20);

  let out = seq;
  if (dv) out += `-${dv}`;
  if (ano) out += `.${ano}`;
  if (jus) out += `.${jus}`;
  if (trib) out += `.${trib}`;
  if (origem) out += `.${origem}`;
  return out;
}
