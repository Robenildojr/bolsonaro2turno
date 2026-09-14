/**
 * Chaveiro — a raiz de toda a confiança do sistema.
 *
 * Cifragem em envelope:
 *
 *   senha-mestra ──scrypt──► KEK ──AES-GCM──► DEK (raiz de 32 bytes, aleatória)
 *                                              │
 *                                              ├─HKDF─► chave de dados
 *                                              ├─HKDF─► chave de índice cego
 *                                              └─HKDF─► chave de backup
 *
 * Por que envelope? Trocar a senha-mestra só reembrulha a DEK: nenhum registro
 * do banco precisa ser recriptografado. E a DEK nunca existe em disco em claro.
 *
 * A senha-mestra não é recuperável. É esse o ponto: nem eu, nem a Anthropic,
 * nem o Google conseguem abrir o backup sem ela.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CryptoError, deriveSubkey, open as openSealed, seal } from './cipher.js';
import { createLogger } from '../../util/logger.js';

const log = createLogger('keyring');

export interface KdfParams {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keyLen: number;
  salt: string; // base64
}

interface KeyringFile {
  version: 1;
  kdf: KdfParams;
  /** DEK embrulhada pela KEK. */
  wrapped: string; // base64 do bloco selado
  /** Texto conhecido selado com a DEK — confere a senha sem tocar no banco. */
  check: string;
  createdAt: string;
  rotatedAt?: string;
  hint?: string;
}

const CHECK_PLAINTEXT = 'iris:keyring:ok:v1';

/**
 * Parâmetros padrão: N = 2^17 → ~134 MB de memória e ~1 s num laptop atual.
 * `IRIS_KDF_N` permite baixar o custo em máquinas fracas (e nos testes), com
 * piso em 2^14 para não virar uma senha decorativa.
 */
function defaultN(): number {
  const raw = Number(process.env.IRIS_KDF_N);
  if (!Number.isFinite(raw) || raw <= 0) return 1 << 17;
  const pow = Math.round(Math.log2(raw));
  return 2 ** Math.min(20, Math.max(14, pow));
}

export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = {
  algo: 'scrypt',
  get N() {
    return defaultN();
  },
  r: 8,
  p: 1,
  keyLen: 32,
} as Omit<KdfParams, 'salt'>;

function deriveKek(passphrase: string, kdf: KdfParams): Buffer {
  const salt = Buffer.from(kdf.salt, 'base64');
  // maxmem precisa acomodar 128 * N * r com folga, senão o Node recusa.
  const maxmem = 256 * kdf.N * kdf.r;
  return scryptSync(passphrase.normalize('NFKC'), salt, kdf.keyLen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem,
  });
}

export class Keyring {
  private root: Buffer | null = null;
  private cache = new Map<string, Buffer>();

  constructor(private readonly file: string) {}

  get path(): string {
    return this.file;
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  get unlocked(): boolean {
    return this.root !== null;
  }

  /** Cria um chaveiro novo. Falha se já existir — nunca sobrescreve. */
  create(passphrase: string, opts: { hint?: string } = {}): void {
    if (this.exists()) throw new CryptoError('já existe um chaveiro neste perfil');
    assertPassphraseStrength(passphrase);

    const kdf: KdfParams = { ...DEFAULT_KDF, salt: randomBytes(32).toString('base64') };
    const kek = deriveKek(passphrase, kdf);
    const root = randomBytes(32);

    const data: KeyringFile = {
      version: 1,
      kdf,
      wrapped: seal(kek, root, 'iris:keyring:wrap').toString('base64'),
      check: seal(deriveSubkey(root, 'iris:check:v1'), CHECK_PLAINTEXT, 'iris:keyring:check').toString('base64'),
      createdAt: new Date().toISOString(),
      ...(opts.hint ? { hint: opts.hint } : {}),
    };

    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    kek.fill(0);
    this.root = root;
    log.info('chaveiro criado', { file: this.file, N: kdf.N });
  }

  unlock(passphrase: string): void {
    const data = this.read();
    const kek = deriveKek(passphrase, data.kdf);
    let root: Buffer;
    try {
      root = openSealed(kek, Buffer.from(data.wrapped, 'base64'), 'iris:keyring:wrap');
    } catch {
      kek.fill(0);
      throw new CryptoError('senha-mestra incorreta');
    }
    kek.fill(0);

    // Confirma que a DEK realmente abre o texto de verificação.
    const check = openSealed(
      deriveSubkey(root, 'iris:check:v1'),
      Buffer.from(data.check, 'base64'),
      'iris:keyring:check',
    );
    if (!timingSafeEqual(check, Buffer.from(CHECK_PLAINTEXT, 'utf8'))) {
      root.fill(0);
      throw new CryptoError('chaveiro corrompido');
    }

    this.root = root;
    this.cache.clear();
    log.info('chaveiro destrancado');
  }

  /** Apaga as chaves da memória. Depois disso nada mais decifra até destrancar de novo. */
  lock(): void {
    this.root?.fill(0);
    for (const k of this.cache.values()) k.fill(0);
    this.cache.clear();
    this.root = null;
    log.info('chaveiro trancado');
  }

  /** Troca a senha-mestra reembrulhando a mesma DEK — o banco não é tocado. */
  changePassphrase(current: string, next: string): void {
    this.unlock(current);
    assertPassphraseStrength(next);
    const data = this.read();
    const kdf: KdfParams = { ...DEFAULT_KDF, salt: randomBytes(32).toString('base64') };
    const kek = deriveKek(next, kdf);
    const updated: KeyringFile = {
      ...data,
      kdf,
      wrapped: seal(kek, this.rootKey(), 'iris:keyring:wrap').toString('base64'),
      rotatedAt: new Date().toISOString(),
    };
    kek.fill(0);
    this.writeAtomic(updated);
    log.info('senha-mestra trocada');
  }

  /** Chave derivada para um propósito. `purpose` deve ser estável para sempre. */
  key(purpose: 'data' | 'index' | 'backup' | 'vault' | 'audit'): Buffer {
    const cached = this.cache.get(purpose);
    if (cached) return cached;
    const derived = deriveSubkey(this.rootKey(), `iris:${purpose}:v1`);
    this.cache.set(purpose, derived);
    return derived;
  }

  /**
   * Chave de backup derivada diretamente da senha, sem passar pela DEK.
   * Assim um bundle no Drive pode ser restaurado em outra máquina só com a
   * senha-mestra, mesmo que o keyring.json original tenha se perdido.
   */
  backupKeyFromPassphrase(passphrase: string, salt: Buffer): Buffer {
    const kdf: KdfParams = { ...DEFAULT_KDF, salt: salt.toString('base64') };
    const kek = deriveKek(passphrase, kdf);
    const key = deriveSubkey(kek, 'iris:backup-file:v1');
    kek.fill(0);
    return key;
  }

  private rootKey(): Buffer {
    if (!this.root) throw new CryptoError('chaveiro trancado — destranque com a senha-mestra');
    return this.root;
  }

  private read(): KeyringFile {
    if (!this.exists()) throw new CryptoError('chaveiro não encontrado — rode `npm run setup`');
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as KeyringFile;
    if (raw.version !== 1) throw new CryptoError(`chaveiro versão ${raw.version} não suportado`);
    return raw;
  }

  private writeAtomic(data: KeyringFile): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function assertPassphraseStrength(passphrase: string): void {
  const p = passphrase.normalize('NFKC');
  if (p.length < 12) {
    throw new CryptoError(
      'a senha-mestra precisa de pelo menos 12 caracteres — ela protege tudo, inclusive o backup',
    );
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (p.length < 20 && classes < 3) {
    throw new CryptoError(
      'senha fraca: use 20+ caracteres ou misture maiúsculas, minúsculas, números e símbolos',
    );
  }
}

let singleton: Keyring | null = null;

export function getKeyring(file?: string): Keyring {
  if (!singleton) {
    if (!file) throw new CryptoError('chaveiro ainda não inicializado');
    singleton = new Keyring(file);
  }
  return singleton;
}

export function resetKeyringForTests(): void {
  singleton?.lock();
  singleton = null;
}
