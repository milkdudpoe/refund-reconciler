// The cryptographic boundary: native WebCrypto only (no custom primitives, no
// crypto dependency). Used only by the service worker. Nothing here touches
// storage, and no key, passphrase or plaintext is ever logged.
//
// - Data key: random 256-bit AES-GCM key (crypto.subtle.generateKey).
// - Wrapping key: PBKDF2-HMAC-SHA-256 over the passphrase's UTF-8 bytes,
//   16-byte random salt, 600,000 iterations (format 1, fixed).
// - Key wrap and payload: AES-GCM, fresh random 12-byte IV per encryption,
//   128-bit tag, explicit additional authenticated data (see format.ts).
// See docs/vault.md.

import { parseStore } from '../domain/validate';
import type { StoreData } from '../domain/types';
import {
  CIPHER_NAME,
  IV_BYTES,
  KDF_ITERATIONS,
  KDF_NAME,
  KEY_BYTES,
  SALT_BYTES,
  VAULT_FORMAT,
  VAULT_FORMAT_VERSION,
  base64ToBytes,
  bytesToBase64,
  keyWrapAad,
  payloadAad,
  type VaultEnvelope,
} from './format';

const TAG_LENGTH_BITS = 128;

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytes(b64: string): Uint8Array<ArrayBuffer> {
  const out = base64ToBytes(b64);
  // Envelopes reach this module only after parseEnvelope(), which checked every field.
  if (out === null) throw new Error('internal: unchecked envelope field');
  return new Uint8Array(out);
}

function gcm(iv: Uint8Array<ArrayBuffer>, aad: Uint8Array): AesGcmParams {
  return { name: 'AES-GCM', iv, additionalData: new Uint8Array(aad), tagLength: TAG_LENGTH_BITS };
}

/** PBKDF2-HMAC-SHA-256, 600,000 iterations. The derived key can only wrap and unwrap; it is never extractable. */
export async function deriveWrappingKey(passphrase: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: KDF_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

/** Encrypts the whole validated ledger under the data key with a fresh IV. Returns a complete new envelope. */
export async function sealPayload(dataKey: CryptoKey, header: Pick<VaultEnvelope, 'vaultId' | 'kdf' | 'keyWrap'>, store: StoreData): Promise<VaultEnvelope> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(store));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, payloadAad(header)), dataKey, plaintext));
  return {
    format: VAULT_FORMAT,
    formatVersion: VAULT_FORMAT_VERSION,
    vaultId: header.vaultId,
    kdf: header.kdf,
    keyWrap: header.keyWrap,
    payload: { cipher: CIPHER_NAME, iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) },
  };
}

/**
 * Creates a new vault: a random data key wrapped under a key derived from the
 * passphrase with a fresh salt, and the ledger encrypted under the data key.
 */
export async function createVault(passphrase: Uint8Array, vaultId: string, store: StoreData): Promise<{ envelope: VaultEnvelope; dataKey: CryptoKey }> {
  const salt = randomBytes(SALT_BYTES);
  const kdf = { name: KDF_NAME, iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) } as const;
  const wrappingKey = await deriveWrappingKey(passphrase, salt);
  // Extractable only so it can be wrapped here and kept for this browser session (see docs/vault.md).
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapIv = randomBytes(IV_BYTES);
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, wrappingKey, gcm(wrapIv, keyWrapAad({ vaultId, kdf }))));
  const keyWrap = { cipher: CIPHER_NAME, iv: bytesToBase64(wrapIv), wrappedKey: bytesToBase64(wrapped) } as const;
  return { envelope: await sealPayload(dataKey, { vaultId, kdf, keyWrap }, store), dataKey };
}

/**
 * Unwraps the data key. Returns null if authentication fails: the passphrase
 * is wrong OR the wrapped key, its IV or its authenticated metadata were
 * damaged. AES-GCM cannot tell these apart, and neither does the UI.
 */
export async function unwrapDataKey(wrappingKey: CryptoKey, envelope: VaultEnvelope): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      bytes(envelope.keyWrap.wrappedKey),
      wrappingKey,
      gcm(bytes(envelope.keyWrap.iv), keyWrapAad(envelope)),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OperationError') return null;
    throw err;
  }
}

export type OpenResult =
  | { readonly status: 'ok'; readonly store: StoreData }
  /** The key does not authenticate this payload (damaged ciphertext, IV or metadata, or a different key). */
  | { readonly status: 'auth_failed' }
  /** Authenticated, but not strict UTF-8 JSON that passes parseStore(). Never repaired. */
  | { readonly status: 'invalid'; readonly detail: string }
  /** Authenticated JSON whose schemaVersion this build does not read. */
  | { readonly status: 'unsupported'; readonly detail: string };

/** Decrypts and validates the ledger. An authenticated payload must still pass domain validation. */
export async function openPayload(dataKey: CryptoKey, envelope: VaultEnvelope): Promise<OpenResult> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(gcm(bytes(envelope.payload.iv), payloadAad(envelope)), dataKey, bytes(envelope.payload.ciphertext));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'OperationError') return { status: 'auth_failed' };
    throw err;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch {
    return { status: 'invalid', detail: 'decrypted ledger is not valid UTF-8' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: 'invalid', detail: 'decrypted ledger is not valid JSON' };
  }
  const parsed = parseStore(json);
  switch (parsed.status) {
    case 'ok':
      return { status: 'ok', store: parsed.store };
    case 'unsupported_version':
      return { status: 'unsupported', detail: `decrypted ledger has schema version ${JSON.stringify(parsed.version) ?? 'missing'}` };
    case 'corrupt':
      return { status: 'invalid', detail: `decrypted ledger failed validation (${parsed.error})` };
  }
}

export async function exportRawKey(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  if (raw.length !== KEY_BYTES) throw new Error('internal: unexpected key length');
  return bytesToBase64(raw);
}

export async function importRawKey(b64: string): Promise<CryptoKey | null> {
  const raw = base64ToBytes(b64);
  if (raw === null || raw.length !== KEY_BYTES) return null;
  // The in-memory copy is not extractable: the raw bytes already live only in the session record.
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
