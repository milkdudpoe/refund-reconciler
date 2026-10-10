// The cryptographic boundary and the envelope parser, with real WebCrypto and
// the production 600,000-iteration work factor (never lowered for tests:
// derivations are kept few instead).

import { beforeAll, describe, expect, it } from 'vitest';
import { createVault, deriveWrappingKey, openPayload, sealPayload, unwrapDataKey } from '../../src/vault/crypto';
import {
  KDF_ITERATIONS,
  MAX_PAYLOAD_BASE64_CHARS,
  base64ToBytes,
  bytesToBase64,
  keyWrapAad,
  parseEnvelope,
  payloadAad,
  type VaultEnvelope,
} from '../../src/vault/format';
import { checkPassphrase } from '../../src/vault/passphrase';
import { parseStore } from '../../src/domain/validate';
import type { StoreData } from '../../src/domain/types';
import { richLegacyLedger } from '../shared/rich-ledger';

const PHRASE = checkPassphrase('synthetic crypto phrase 01');
if (!PHRASE.ok) throw new Error('fixture');
const passBytes = PHRASE.bytes;
const STORE = (() => {
  const p = parseStore(richLegacyLedger());
  if (p.status !== 'ok') throw new Error('fixture');
  return p.store;
})();

let envelope: VaultEnvelope;
let dataKey: CryptoKey;
let wrappingKey: CryptoKey;
let setupMs = 0;
let unlockMs = 0;

function flip(b64: string, index = 0): string {
  const bytes = base64ToBytes(b64)!;
  bytes[index] = bytes[index]! ^ 0x01;
  return bytesToBase64(bytes);
}

function withField(e: VaultEnvelope, path: string[], value: unknown): unknown {
  const copy = structuredClone(e) as unknown as Record<string, any>;
  let o = copy;
  for (const p of path.slice(0, -1)) o = o[p];
  o[path.at(-1)!] = value;
  return copy;
}

beforeAll(async () => {
  let t = performance.now();
  ({ envelope, dataKey } = await createVault(passBytes, 'vault-test-0001', STORE));
  setupMs = performance.now() - t;
  t = performance.now();
  wrappingKey = await deriveWrappingKey(passBytes, base64ToBytes(envelope.kdf.salt)!);
  const unwrapped = await unwrapDataKey(wrappingKey, envelope);
  if (!unwrapped || (await openPayload(unwrapped, envelope)).status !== 'ok') throw new Error('unlock failed');
  unlockMs = performance.now() - t;
  // Reported, not asserted: see docs/vault.md for recorded timings.
  console.info(`KDF timing (Node ${process.version}, ${process.platform}/${process.arch}): setup ${setupMs.toFixed(0)} ms, unlock ${unlockMs.toFixed(0)} ms at ${KDF_ITERATIONS} iterations`);
});

describe('vault envelope', () => {
  it('records the format, KDF parameters and exact lengths; nothing private is plaintext metadata', () => {
    expect(parseEnvelope(envelope)).toEqual({ status: 'ok', envelope });
    expect(envelope.kdf).toEqual({ name: 'PBKDF2-HMAC-SHA-256', iterations: 600_000, salt: expect.any(String) });
    expect(base64ToBytes(envelope.kdf.salt)).toHaveLength(16);
    expect(base64ToBytes(envelope.keyWrap.iv)).toHaveLength(12);
    expect(base64ToBytes(envelope.keyWrap.wrappedKey)).toHaveLength(48);
    expect(base64ToBytes(envelope.payload.iv)).toHaveLength(12);
    expect(Object.keys(envelope).sort()).toEqual(['format', 'formatVersion', 'kdf', 'keyWrap', 'payload', 'vaultId']);
    const text = JSON.stringify(envelope);
    for (const secret of ['PRIVATE-NOTE-RESTORE', 'Synthetic lamp', 'STMT-1', 'Refund issued', '112-1234567', 'synthetic-restore-op', 'synthetic-erase-epoch']) expect(text).not.toContain(secret);
  });

  it('decrypts to exactly the validated ledger, field for field', async () => {
    expect(await openPayload(dataKey, envelope)).toEqual({ status: 'ok', store: STORE });
  });

  it('uses a fresh random IV for every encryption under the same key', async () => {
    const ivs = new Set([envelope.payload.iv]);
    for (let i = 0; i < 50; i++) ivs.add((await sealPayload(dataKey, envelope, STORE)).payload.iv);
    expect(ivs.size).toBe(51);
    const again = await createVault(passBytes, 'vault-test-0002', STORE);
    expect(again.envelope.kdf.salt).not.toBe(envelope.kdf.salt);
    expect(again.envelope.keyWrap.iv).not.toBe(envelope.keyWrap.iv);
  });

  it('separates key-wrap and payload authentication contexts', () => {
    expect(new TextDecoder().decode(keyWrapAad(envelope))).toBe(
      JSON.stringify(['refund-reconciler-vault', 1, 'key-wrap', envelope.vaultId, 'PBKDF2-HMAC-SHA-256', 600000, envelope.kdf.salt, 'AES-256-GCM']),
    );
    expect(new TextDecoder().decode(payloadAad(envelope))).toBe(JSON.stringify(['refund-reconciler-vault', 1, 'ledger-payload', envelope.vaultId, 'AES-256-GCM']));
  });

  it('rejects unsupported versions and parameters before any derivation, and malformed fields strictly', () => {
    const cases: [string[], unknown, 'unsupported' | 'corrupt'][] = [
      [['formatVersion'], 2, 'unsupported'],
      [['formatVersion'], '1', 'corrupt'],
      [['format'], 'other', 'corrupt'],
      [['kdf', 'iterations'], 600_001, 'unsupported'],
      [['kdf', 'iterations'], 2 ** 40, 'unsupported'],
      [['kdf', 'iterations'], 1, 'unsupported'],
      [['kdf', 'name'], 'PBKDF2-HMAC-SHA-1', 'unsupported'],
      [['keyWrap', 'cipher'], 'AES-128-GCM', 'unsupported'],
      [['payload', 'cipher'], 'AES-256-CBC', 'unsupported'],
      [['kdf', 'salt'], bytesToBase64(new Uint8Array(15)), 'corrupt'],
      [['kdf', 'salt'], bytesToBase64(new Uint8Array(32)), 'corrupt'],
      [['keyWrap', 'iv'], bytesToBase64(new Uint8Array(16)), 'corrupt'],
      [['payload', 'iv'], bytesToBase64(new Uint8Array(11)), 'corrupt'],
      [['keyWrap', 'wrappedKey'], bytesToBase64(new Uint8Array(40)), 'corrupt'],
      [['payload', 'ciphertext'], bytesToBase64(new Uint8Array(16)), 'corrupt'],
      [['payload', 'ciphertext'], 'A'.repeat(MAX_PAYLOAD_BASE64_CHARS + 4), 'corrupt'],
      [['payload', 'ciphertext'], `${envelope.payload.ciphertext.slice(0, -4)}====`, 'corrupt'],
      [['kdf', 'salt'], envelope.kdf.salt.replace(/=*$/, ''), 'corrupt'],
      [['payload', 'iv'], `${envelope.payload.iv} `, 'corrupt'],
      [['vaultId'], 'not an id!', 'corrupt'],
      [['vaultId'], 'x'.repeat(65), 'corrupt'],
      [['payload', 'extra'], 1, 'corrupt'],
      [['kdf'], null, 'corrupt'],
    ];
    for (const [path, value, status] of cases) expect(parseEnvelope(withField(envelope, path, value)), path.join('.')).toMatchObject({ status });
    const missing = structuredClone(envelope) as unknown as Record<string, unknown>;
    delete missing.payload;
    expect(parseEnvelope(missing)).toMatchObject({ status: 'corrupt' });
    expect(parseEnvelope({ ...envelope, extra: true })).toMatchObject({ status: 'corrupt' });
    for (const v of [null, 'x', [], 42]) expect(parseEnvelope(v)).toMatchObject({ status: 'corrupt' });
  });

  it('canonical base64 only: non-zero padding bits are refused', () => {
    expect(base64ToBytes('AA==')).toEqual(new Uint8Array([0]));
    expect(base64ToBytes('AB==')).toBeNull();
    expect(base64ToBytes('A-==')).toBeNull();
  });
});

describe('authentication and tampering', () => {
  it('a wrong passphrase and a damaged wrapped key, IV or authenticated metadata all fail the same way', async () => {
    const wrong = checkPassphrase('synthetic crypto phrase 02');
    if (!wrong.ok) throw new Error('fixture');
    expect(await unwrapDataKey(await deriveWrappingKey(wrong.bytes, base64ToBytes(envelope.kdf.salt)!), envelope)).toBeNull();
    const tampered: unknown[] = [
      withField(envelope, ['keyWrap', 'wrappedKey'], flip(envelope.keyWrap.wrappedKey)),
      withField(envelope, ['keyWrap', 'wrappedKey'], flip(envelope.keyWrap.wrappedKey, 47)),
      withField(envelope, ['keyWrap', 'iv'], flip(envelope.keyWrap.iv)),
      // Authenticated metadata: a different vault id is bound into the AAD.
      withField(envelope, ['vaultId'], 'vault-test-9999'),
    ];
    for (const t of tampered) {
      const parsed = parseEnvelope(t);
      if (parsed.status !== 'ok') throw new Error('tampered envelope must still be well-formed');
      expect(await unwrapDataKey(wrappingKey, parsed.envelope)).toBeNull();
    }
    // A different salt derives a different key (one more derivation).
    const salted = parseEnvelope(withField(envelope, ['kdf', 'salt'], flip(envelope.kdf.salt)));
    if (salted.status !== 'ok') throw new Error('fixture');
    expect(await unwrapDataKey(await deriveWrappingKey(passBytes, base64ToBytes(salted.envelope.kdf.salt)!), salted.envelope)).toBeNull();
    // ...and even with the right key, the salt is authenticated metadata.
    expect(await unwrapDataKey(wrappingKey, salted.envelope)).toBeNull();
  });

  it('tampered ciphertext, payload IV or vault id fail authentication and are never treated as a ledger', async () => {
    for (const t of [
      withField(envelope, ['payload', 'ciphertext'], flip(envelope.payload.ciphertext, 5)),
      withField(envelope, ['payload', 'ciphertext'], flip(envelope.payload.ciphertext, base64ToBytes(envelope.payload.ciphertext)!.length - 1)),
      withField(envelope, ['payload', 'iv'], flip(envelope.payload.iv)),
      withField(envelope, ['vaultId'], 'vault-test-9999'),
    ]) {
      const parsed = parseEnvelope(t);
      if (parsed.status !== 'ok') throw new Error('fixture');
      expect(await openPayload(dataKey, parsed.envelope)).toEqual({ status: 'auth_failed' });
    }
    // A wrapped key placed in the payload slot fails: the contexts differ.
    const swapped = parseEnvelope(withField(envelope, ['payload'], { cipher: 'AES-256-GCM', iv: envelope.keyWrap.iv, ciphertext: envelope.keyWrap.wrappedKey }));
    if (swapped.status !== 'ok') throw new Error('fixture');
    expect(await openPayload(dataKey, swapped.envelope)).toEqual({ status: 'auth_failed' });
  });

  it('an authenticated payload must still be strict UTF-8 JSON that passes domain validation', async () => {
    async function sealRaw(bytes: Uint8Array): Promise<VaultEnvelope> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(payloadAad(envelope)), tagLength: 128 }, dataKey, new Uint8Array(bytes)));
      return { ...envelope, payload: { cipher: 'AES-256-GCM', iv: bytesToBase64(iv), ciphertext: bytesToBase64(ct) } };
    }
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(await openPayload(dataKey, await sealRaw(new Uint8Array([0x7b, 0xff, 0x7d])))).toMatchObject({ status: 'invalid', detail: expect.stringContaining('UTF-8') });
    expect(await openPayload(dataKey, await sealRaw(enc('{"schemaVersion":1,')))).toMatchObject({ status: 'invalid', detail: expect.stringContaining('JSON') });
    expect(await openPayload(dataKey, await sealRaw(enc(JSON.stringify({ schemaVersion: 1, revision: -1, cases: [] }))))).toMatchObject({ status: 'invalid' });
    expect(await openPayload(dataKey, await sealRaw(enc(JSON.stringify({ schemaVersion: 2, revision: 0, cases: [] }))))).toMatchObject({ status: 'unsupported' });
    // A historical capture is not re-parsed: stored as is, read back as is.
    const bad = structuredClone(STORE) as StoreData;
    expect(await openPayload(dataKey, await sealPayload(dataKey, envelope, bad))).toEqual({ status: 'ok', store: STORE });
  });
});

describe('passphrase rules', () => {
  it('counts code points, bounds UTF-8 bytes and refuses lone surrogates, without transforming anything', () => {
    expect(checkPassphrase('a'.repeat(11))).toEqual({ ok: false, problem: 'too_short' });
    expect(checkPassphrase('a'.repeat(12))).toMatchObject({ ok: true });
    expect(checkPassphrase('🔒'.repeat(11))).toEqual({ ok: false, problem: 'too_short' });
    expect(checkPassphrase('a'.repeat(1024))).toMatchObject({ ok: true });
    expect(checkPassphrase('a'.repeat(1025))).toEqual({ ok: false, problem: 'too_long' });
    expect(checkPassphrase('é'.repeat(512))).toMatchObject({ ok: true });
    expect(checkPassphrase('é'.repeat(513))).toEqual({ ok: false, problem: 'too_long' });
    expect(checkPassphrase(`${'a'.repeat(12)}\uDC00`)).toEqual({ ok: false, problem: 'malformed' });
    expect(checkPassphrase(42)).toEqual({ ok: false, problem: 'not_text' });
    const spaced = checkPassphrase('  twelve chars ok  ');
    expect(spaced.ok && new TextDecoder().decode(spaced.bytes)).toBe('  twelve chars ok  ');
    const decomposed = checkPassphrase('café twelve chars');
    expect(decomposed.ok && Array.from(decomposed.bytes).slice(3, 6)).toEqual([0x65, 0xcc, 0x81]);
  });
});
