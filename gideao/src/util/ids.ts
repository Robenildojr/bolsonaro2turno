import { randomBytes, randomUUID } from 'node:crypto';

/** Identificador curto, ordenável por tempo (26 chars, base32 Crockford). */
export function ulid(): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.now();
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ALPHABET[time % 32]!);
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  let randChars = '';
  for (let i = 0; i < 16; i++) randChars += ALPHABET[rand[i]! % 32]!;
  return timeChars.join('') + randChars;
}

export function uuid(): string {
  return randomUUID();
}

/** Prefixa o id para facilitar leitura em logs: mem_01H..., cap_01H... */
export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
