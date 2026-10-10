// The encrypted storage envelope (vault format 1) and its strict validation.
// Pure: no WebCrypto, no storage. Everything read from storage is checked
// here, field by field, BEFORE any expensive key derivation or decryption is
// attempted. See docs/vault.md for the format and its authenticated fields.

import { isId } from '../domain/validate';

export const VAULT_FORMAT = 'refund-reconciler-vault';
/** Version of this envelope. Independent of the ledger's schemaVersion and of the backup format. */
export const VAULT_FORMAT_VERSION = 1;

/** The only key-derivation parameters format 1 accepts. Never configurable, never read from input. */
export const KDF_NAME = 'PBKDF2-HMAC-SHA-256';
export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;

export const CIPHER_NAME = 'AES-256-GCM';
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** A 256-bit key wrapped with AES-GCM: 32 key bytes plus the 16-byte tag. */
export const WRAPPED_KEY_BYTES = KEY_BYTES + TAG_BYTES;

/**
 * Largest encrypted payload accepted, as base64 text (16 MiB of characters,
 * about 12 MiB of ciphertext). chrome.storage.local holds at most 10 MB in
 * total, so a valid vault is always smaller; this only bounds the work done on
 * hostile or damaged input before it is decoded.
 */
export const MAX_PAYLOAD_BASE64_CHARS = 16 * 1024 * 1024;

export interface VaultEnvelope {
  readonly format: typeof VAULT_FORMAT;
  readonly formatVersion: typeof VAULT_FORMAT_VERSION;
  /** Random identity of this vault. A new vault (setup, migration, re-setup after erase) always gets a new one. */
  readonly vaultId: string;
  readonly kdf: { readonly name: typeof KDF_NAME; readonly iterations: typeof KDF_ITERATIONS; readonly salt: string };
  /** The random data key, wrapped under the passphrase-derived key. */
  readonly keyWrap: { readonly cipher: typeof CIPHER_NAME; readonly iv: string; readonly wrappedKey: string };
  /** The whole validated StoreData JSON, encrypted under the data key. */
  readonly payload: { readonly cipher: typeof CIPHER_NAME; readonly iv: string; readonly ciphertext: string };
}

export type EnvelopeParse =
  | { readonly status: 'ok'; readonly envelope: VaultEnvelope }
  /** A different format version or different algorithms/parameters: never guessed at. */
  | { readonly status: 'unsupported'; readonly detail: string }
  | { readonly status: 'corrupt'; readonly detail: string };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/**
 * Decodes canonical, padded standard base64 only. Anything else (other
 * alphabets, whitespace, missing padding, non-zero trailing bits) is
 * rejected rather than "repaired". Returns null on any problem.
 */
export function base64ToBytes(text: string): Uint8Array | null {
  if (!BASE64.test(text)) return null;
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Non-zero padding bits would decode to the same bytes as another string.
  return bytesToBase64(bytes) === text ? bytes : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class EnvelopeError extends Error {
  constructor(
    readonly kind: 'unsupported' | 'corrupt',
    detail: string,
  ) {
    super(detail);
  }
}

function exact(o: Record<string, unknown>, keys: readonly string[], path: string): void {
  const actual = Object.keys(o);
  for (const k of actual) if (!keys.includes(k)) throw new EnvelopeError('corrupt', `${path}.${k}: unexpected field`);
  for (const k of keys) if (!(k in o)) throw new EnvelopeError('corrupt', `${path}.${k}: missing`);
}

function bytesField(v: unknown, path: string, length: { exactly: number } | { min: number; maxChars: number }): string {
  if (typeof v !== 'string') throw new EnvelopeError('corrupt', `${path}: expected base64 text`);
  if ('maxChars' in length && v.length > length.maxChars) throw new EnvelopeError('corrupt', `${path}: longer than ${length.maxChars} characters`);
  if ('exactly' in length && v.length !== Math.ceil(length.exactly / 3) * 4) throw new EnvelopeError('corrupt', `${path}: expected ${length.exactly} bytes`);
  const bytes = base64ToBytes(v);
  if (bytes === null) throw new EnvelopeError('corrupt', `${path}: not canonical base64`);
  if ('exactly' in length && bytes.length !== length.exactly) throw new EnvelopeError('corrupt', `${path}: expected ${length.exactly} bytes`);
  if ('min' in length && bytes.length < length.min) throw new EnvelopeError('corrupt', `${path}: shorter than ${length.min} bytes`);
  return v;
}

function parseUnsafe(raw: unknown): VaultEnvelope {
  if (!isRecord(raw)) throw new EnvelopeError('corrupt', 'vault: expected an object');
  if (raw.format !== VAULT_FORMAT) throw new EnvelopeError('corrupt', 'vault.format: not a Refund Reconciler vault');
  if (raw.formatVersion !== VAULT_FORMAT_VERSION) {
    throw new EnvelopeError(
      Number.isSafeInteger(raw.formatVersion) ? 'unsupported' : 'corrupt',
      `vault.formatVersion: ${JSON.stringify(raw.formatVersion) ?? 'missing'} is not supported (this build reads version ${VAULT_FORMAT_VERSION})`,
    );
  }
  exact(raw, ['format', 'formatVersion', 'vaultId', 'kdf', 'keyWrap', 'payload'], 'vault');
  if (!isId(raw.vaultId)) throw new EnvelopeError('corrupt', 'vault.vaultId: expected an id');

  const kdf = raw.kdf;
  if (!isRecord(kdf)) throw new EnvelopeError('corrupt', 'vault.kdf: expected an object');
  exact(kdf, ['name', 'iterations', 'salt'], 'vault.kdf');
  if (kdf.name !== KDF_NAME) throw new EnvelopeError('unsupported', `vault.kdf.name: only ${KDF_NAME} is supported`);
  // Exactly the format-1 work factor: an attacker-chosen huge (or tiny) count is refused before any derivation.
  if (kdf.iterations !== KDF_ITERATIONS) throw new EnvelopeError('unsupported', `vault.kdf.iterations: only ${KDF_ITERATIONS} is supported`);
  const salt = bytesField(kdf.salt, 'vault.kdf.salt', { exactly: SALT_BYTES });

  const wrap = raw.keyWrap;
  if (!isRecord(wrap)) throw new EnvelopeError('corrupt', 'vault.keyWrap: expected an object');
  exact(wrap, ['cipher', 'iv', 'wrappedKey'], 'vault.keyWrap');
  if (wrap.cipher !== CIPHER_NAME) throw new EnvelopeError('unsupported', `vault.keyWrap.cipher: only ${CIPHER_NAME} is supported`);
  const wrapIv = bytesField(wrap.iv, 'vault.keyWrap.iv', { exactly: IV_BYTES });
  const wrappedKey = bytesField(wrap.wrappedKey, 'vault.keyWrap.wrappedKey', { exactly: WRAPPED_KEY_BYTES });

  const payload = raw.payload;
  if (!isRecord(payload)) throw new EnvelopeError('corrupt', 'vault.payload: expected an object');
  exact(payload, ['cipher', 'iv', 'ciphertext'], 'vault.payload');
  if (payload.cipher !== CIPHER_NAME) throw new EnvelopeError('unsupported', `vault.payload.cipher: only ${CIPHER_NAME} is supported`);
  const payloadIv = bytesField(payload.iv, 'vault.payload.iv', { exactly: IV_BYTES });
  // At least the tag plus one byte: the smallest StoreData JSON is far longer.
  const ciphertext = bytesField(payload.ciphertext, 'vault.payload.ciphertext', { min: TAG_BYTES + 1, maxChars: MAX_PAYLOAD_BASE64_CHARS });

  return {
    format: VAULT_FORMAT,
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: raw.vaultId,
    kdf: { name: KDF_NAME, iterations: KDF_ITERATIONS, salt },
    keyWrap: { cipher: CIPHER_NAME, iv: wrapIv, wrappedKey },
    payload: { cipher: CIPHER_NAME, iv: payloadIv, ciphertext },
  };
}

/** Strict validation of a stored envelope. Never repairs, migrates or defaults anything. */
export function parseEnvelope(raw: unknown): EnvelopeParse {
  try {
    return { status: 'ok', envelope: parseUnsafe(raw) };
  } catch (err) {
    if (err instanceof EnvelopeError) return { status: err.kind, detail: err.message };
    throw err;
  }
}

/**
 * Additional authenticated data, deterministically encoded as the UTF-8 bytes
 * of a JSON array of strings and safe integers (no objects, so no key-order
 * ambiguity). The two contexts differ in their third element, so a wrapped key
 * can never be accepted as a payload or the reverse. Every public field that
 * affects decryption is bound: changing the format, version, vault id, KDF
 * name, iteration count, salt or cipher makes authentication fail.
 */
export function keyWrapAad(e: Pick<VaultEnvelope, 'vaultId' | 'kdf'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([VAULT_FORMAT, VAULT_FORMAT_VERSION, 'key-wrap', e.vaultId, e.kdf.name, e.kdf.iterations, e.kdf.salt, CIPHER_NAME]));
}

export function payloadAad(e: Pick<VaultEnvelope, 'vaultId'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([VAULT_FORMAT, VAULT_FORMAT_VERSION, 'ledger-payload', e.vaultId, CIPHER_NAME]));
}

// ---- Nonprivate records kept beside the vault ----

export const MIGRATION_FORMAT = 'refund-reconciler-migration';

/**
 * Written before the candidate vault and kept until the plaintext original is
 * removed, so an interrupted migration is never mistaken for a finished one.
 * Holds no ledger data.
 */
export interface MigrationMarker {
  readonly format: typeof MIGRATION_FORMAT;
  readonly formatVersion: 1;
  /** candidate: the encrypted copy may exist but is not verified. verified: it matched the original field for field. */
  readonly phase: 'candidate' | 'verified';
  readonly vaultId: string;
}

export function parseMigrationMarker(raw: unknown): MigrationMarker | null {
  if (!isRecord(raw) || Object.keys(raw).length !== 4) return null;
  if (raw.format !== MIGRATION_FORMAT || raw.formatVersion !== 1 || (raw.phase !== 'candidate' && raw.phase !== 'verified') || !isId(raw.vaultId)) return null;
  return { format: MIGRATION_FORMAT, formatVersion: 1, phase: raw.phase, vaultId: raw.vaultId };
}

export const ERASE_FORMAT = 'refund-reconciler-erased';

/** Left by an explicit erase: a fresh random identity and nothing else. */
export interface EraseMarker {
  readonly format: typeof ERASE_FORMAT;
  readonly formatVersion: 1;
  readonly epoch: string;
}

export function parseEraseMarker(raw: unknown): EraseMarker | null {
  if (!isRecord(raw) || Object.keys(raw).length !== 3) return null;
  if (raw.format !== ERASE_FORMAT || raw.formatVersion !== 1 || !isId(raw.epoch)) return null;
  return { format: ERASE_FORMAT, formatVersion: 1, epoch: raw.epoch };
}

export const SESSION_FORMAT = 'refund-reconciler-session';

/**
 * The unlocked data key, kept ONLY in chrome.storage.session (memory, not
 * disk) so a suspended service worker can resume without the passphrase.
 * Valid only for the vault it names and the current session generation.
 */
export interface SessionRecord {
  readonly format: typeof SESSION_FORMAT;
  readonly formatVersion: 1;
  readonly vaultId: string;
  readonly generation: string;
  readonly key: string;
}

export function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!isRecord(raw) || Object.keys(raw).length !== 5) return null;
  if (raw.format !== SESSION_FORMAT || raw.formatVersion !== 1 || !isId(raw.vaultId) || !isId(raw.generation) || typeof raw.key !== 'string') return null;
  const key = base64ToBytes(raw.key);
  if (key === null || key.length !== KEY_BYTES) return null;
  return { format: SESSION_FORMAT, formatVersion: 1, vaultId: raw.vaultId, generation: raw.generation, key: raw.key };
}
