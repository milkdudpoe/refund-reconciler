// Agreement to the data practices: the receipt format, the request/reply
// validation and the service worker's consent gate. Storage areas are the
// in-memory fakes (tests/unit/vault-fakes.ts); all cryptography is real
// WebCrypto, spied on (not replaced) to show that a refused request never
// reaches it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERASE_CONFIRMATION, isConsentResponse, parseRequest } from '../../src/background/messages';
import { DATA_PRACTICES, DATA_PRACTICES_VERSION } from '../../src/consent/practices';
import { CONSENT_FORMAT, parseConsent } from '../../src/consent/receipt';
import { CONSENT_KEY, ERASE_KEY, LEGACY_STORE_KEY, SESSION_KEY, VAULT_KEY } from '../../src/persistence/storage';
import { parseLedgerState } from '../../src/vault/state';
import { richLedger, richLegacyLedger } from '../shared/rich-ledger';
import { PHRASE, agree, makeWorld, readLedger, recordKeys, settle, setUp, storedStore } from './vault-fakes';

const RECEIPT = { format: CONSENT_FORMAT, formatVersion: 1, dataPracticesVersion: 1, acceptedAt: '2026-10-01T00:00:00.000Z' };
const ACCEPT = { kind: 'acceptDataPractices', version: DATA_PRACTICES_VERSION };
const ERASE = { kind: 'eraseAll', confirm: ERASE_CONFIRMATION };
const backupEnvelope = { format: 'refund-reconciler-backup', formatVersion: 1, exportedAt: '2026-10-09T08:00:00.000Z', store: richLedger() };

/** Every gated request kind, as a page (or a forged direct message) would send it. */
function gatedRequests(expected = { revision: 0, stored: true, epoch: null as string | null }): Record<string, unknown>[] {
  return [
    { kind: 'readLegacy' },
    { kind: 'setup', passphrase: PHRASE, acknowledged: true },
    { kind: 'migrate', passphrase: PHRASE, acknowledged: true, replaceCandidate: false },
    { kind: 'unlock', passphrase: PHRASE },
    { kind: 'mutate', command: { type: 'loadDemo' } },
    { kind: 'mutate', command: { type: 'createCase', caseId: 'c1', orderRef: null, items: [{ itemId: 'c1-a', label: 'Item', expectedCents: 100, expectationEntryId: 'c1-e' }] } },
    { kind: 'restore', operationId: 'op-1', expected, backup: backupEnvelope },
  ];
}

/** Spies on (does not replace) every WebCrypto operation the vault uses. */
function spyOnCrypto() {
  const names = ['deriveKey', 'importKey', 'unwrapKey', 'decrypt', 'encrypt', 'generateKey', 'wrapKey', 'exportKey'] as const;
  const spies = names.map((n) => vi.spyOn(globalThis.crypto.subtle, n));
  return { calls: () => spies.reduce((sum, s) => sum + s.mock.calls.length, 0) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consent receipt format', () => {
  it('accepts only an exact receipt for the current data-practices version', () => {
    expect(parseConsent(RECEIPT)).toEqual({ status: 'accepted', receipt: RECEIPT });
    expect(parseConsent(undefined)).toEqual({ status: 'missing' });
    expect(parseConsent({ ...RECEIPT, dataPracticesVersion: 2 })).toEqual({ status: 'obsolete', version: 2 });
    expect(parseConsent(RECEIPT, 2)).toEqual({ status: 'obsolete', version: 1 });
    const invalid: unknown[] = [
      null,
      true,
      'accepted',
      [],
      {},
      { ...RECEIPT, extra: 1 },
      { ...RECEIPT, userId: 'someone' },
      { format: CONSENT_FORMAT, formatVersion: 1, dataPracticesVersion: 1 },
      { ...RECEIPT, format: 'other' },
      { ...RECEIPT, formatVersion: 2 },
      { ...RECEIPT, formatVersion: '1' },
      { ...RECEIPT, dataPracticesVersion: 0 },
      { ...RECEIPT, dataPracticesVersion: 1.5 },
      { ...RECEIPT, dataPracticesVersion: '1' },
      { ...RECEIPT, dataPracticesVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...RECEIPT, acceptedAt: 'yesterday' },
      { ...RECEIPT, acceptedAt: '2026-13-01T00:00:00Z' },
      { ...RECEIPT, acceptedAt: 0 },
    ];
    for (const raw of invalid) expect(parseConsent(raw), JSON.stringify(raw)).toEqual({ status: 'invalid' });
  });

  it('the displayed text and the enforced version come from one definition', () => {
    expect(DATA_PRACTICES.version).toBe(DATA_PRACTICES_VERSION);
    expect(DATA_PRACTICES_VERSION).toBe(1);
    const text = JSON.stringify(DATA_PRACTICES);
    // Representative content, not every sentence.
    for (const needle of ['Amazon US', '4,000 characters', 'not sent to the publisher', 'not stored', 'no recovery service', 'not encrypted', 'Not now', 'Erase stored data']) expect(text).toContain(needle);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

describe('consent messages', () => {
  it('validates acceptance requests strictly', () => {
    expect(parseRequest(ACCEPT)).toEqual({ ok: true, value: ACCEPT });
    for (const bad of [
      { kind: 'acceptDataPractices' },
      { kind: 'acceptDataPractices', version: '1' },
      { kind: 'acceptDataPractices', version: 0 },
      { kind: 'acceptDataPractices', version: 1.5 },
      { kind: 'acceptDataPractices', version: 1, acceptedAt: '2026-10-01T00:00:00.000Z' },
      { kind: 'acceptDataPractices', version: 1, agreed: true },
    ]) {
      expect(parseRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('pages accept only a well-formed consent state for the version they display, and well-formed replies', () => {
    expect(parseLedgerState({ status: 'consent_required', reason: 'missing', version: 1 })).toEqual({ status: 'consent_required', reason: 'missing', version: 1 });
    expect(parseLedgerState({ status: 'consent_required', reason: 'obsolete', version: 1 })).not.toBeNull();
    expect(parseLedgerState({ status: 'consent_required', reason: 'missing', version: 2 })).toBeNull();
    expect(parseLedgerState({ status: 'consent_required', reason: 'agreed', version: 1 })).toBeNull();
    expect(parseLedgerState({ status: 'consent_required', version: 1 })).toBeNull();
    expect(isConsentResponse({ ok: true, outcome: 'accepted', message: 'x' })).toBe(true);
    expect(isConsentResponse({ ok: true, outcome: 'already_accepted', message: 'x' })).toBe(true);
    expect(isConsentResponse({ ok: true, outcome: 'unlocked', message: 'x' })).toBe(false);
    expect(isConsentResponse({ ok: true, outcome: 'accepted' })).toBe(false);
    expect(isConsentResponse({ ok: false, error: { code: 'write_rejected', message: 'x' } })).toBe(true);
    expect(isConsentResponse({ ok: false })).toBe(false);
  });
});

describe('the consent gate in the service worker', () => {
  it('a fresh installation reads only the receipt and refuses every data operation before any crypto or write', async () => {
    const w = await makeWorld({ consent: false });
    const crypto = spyOnCrypto();
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'missing', version: 1 });
    for (const req of gatedRequests()) {
      expect(await w.send(req), JSON.stringify(req)).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    }
    expect(crypto.calls()).toBe(0);
    expect(w.local.data.size).toBe(0);
    // Only the consent receipt was ever read; the ledger keys were never fetched, and nothing was written.
    expect(w.log.filter((o) => o.area === 'local').every((o) => o.type === 'get' && o.keys.length === 1 && o.keys[0] === CONSENT_KEY)).toBe(true);
    expect(w.log.filter((o) => o.area === 'session')).toEqual([]);
    expect(w.broadcasts).toBe(0);
  });

  it('existing encrypted records stay exactly as stored while agreement is obsolete, even with the session still unlocked', async () => {
    const w = await makeWorld();
    await setUp(w);
    await w.send({ kind: 'mutate', command: { type: 'loadDemo' } });
    await w.send(gatedRequests()[5]!); // create case c1
    const store = await storedStore(w);
    // A future data-practices change (here simulated by a receipt for another version).
    w.local.data.set(CONSENT_KEY, { ...RECEIPT, dataPracticesVersion: 2 });
    const before = structuredClone(Object.fromEntries(w.local.data));
    const session = structuredClone(Object.fromEntries(w.session.data));
    w.log.length = 0;
    const crypto = spyOnCrypto();
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'obsolete', version: 1 });
    // Deleting a saved case also needs agreement (and an unlocked vault); only the typed erase does not.
    const deleteSaved = { kind: 'mutate', command: { type: 'deleteCase', caseId: 'c1' } };
    for (const req of [...gatedRequests({ revision: store.revision, stored: true, epoch: store.ledgerEpoch ?? null }), deleteSaved]) {
      expect(await w.send(req), JSON.stringify(req)).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    }
    expect(crypto.calls()).toBe(0);
    expect(Object.fromEntries(w.local.data)).toEqual(before);
    expect(Object.fromEntries(w.session.data)).toEqual(session);
    expect(w.log.some((o) => o.type !== 'get')).toBe(false);

    // Agreeing replaces only the receipt and leads back to the existing state, unchanged.
    expect(await w.send(ACCEPT)).toMatchObject({ ok: true, outcome: 'accepted' });
    expect(parseConsent(w.local.data.get(CONSENT_KEY))).toMatchObject({ status: 'accepted' });
    expect(w.local.data.get(VAULT_KEY)).toEqual(before[VAULT_KEY]);
    expect(await storedStore(w)).toEqual(store);
    expect(store.cases.some((c: { id: string }) => c.id === 'c1')).toBe(true);
  });

  it('earlier plaintext records are neither read nor migrated before agreement; agreement leads to migration', async () => {
    const w = await makeWorld({ consent: false });
    const legacy = richLegacyLedger();
    w.local.data.set(LEGACY_STORE_KEY, structuredClone(legacy));
    const crypto = spyOnCrypto();
    expect(await readLedger(w)).toMatchObject({ status: 'consent_required', reason: 'missing' });
    expect(await w.send({ kind: 'readLegacy' })).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(await w.send({ kind: 'migrate', passphrase: PHRASE, acknowledged: true, replaceCandidate: false })).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(crypto.calls()).toBe(0);
    expect(recordKeys(w)).toEqual([LEGACY_STORE_KEY]);
    expect(w.local.data.get(LEGACY_STORE_KEY)).toEqual(legacy);
    await agree(w);
    expect(await readLedger(w)).toMatchObject({ status: 'migration_required', stage: 'legacy', legacyCases: legacy.cases.length });
    const receipt = structuredClone(w.local.data.get(CONSENT_KEY));
    expect(await w.send({ kind: 'migrate', passphrase: PHRASE, acknowledged: true, replaceCandidate: false })).toMatchObject({ ok: true, outcome: 'unlocked' });
    // Migration neither creates nor changes the agreement.
    expect(w.local.data.get(CONSENT_KEY)).toEqual(receipt);
    expect(await storedStore(w)).toEqual(legacy);
  });

  it('a damaged receipt is never agreement, and an unreadable one is a storage error, not a first-use prompt', async () => {
    const w = await makeWorld({ consent: false });
    w.local.data.set(CONSENT_KEY, { ...RECEIPT, acceptedAt: 'not a time' });
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'invalid', version: 1 });
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'consent_required' } });

    w.local.fault = (op) => (op.type === 'get' && op.keys.includes(CONSENT_KEY) ? 'reject' : undefined);
    expect(await readLedger(w)).toMatchObject({ status: 'storage_error', error: expect.stringContaining('agreement to the data practices could not be read') });
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(await w.send({ kind: 'readLegacy' })).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(await w.send({ kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    // Acceptance cannot tell whether a newer agreement exists, so it writes nothing.
    expect(await w.send(ACCEPT)).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(w.local.data.get(CONSENT_KEY)).toMatchObject({ acceptedAt: 'not a time' });
    w.local.fault = null;
    expect(await w.send(ACCEPT)).toMatchObject({ ok: true, outcome: 'accepted' });
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: false });
  });

  it('acceptance stores only nonprivate metadata with the worker’s own time, once; repeats are idempotent', async () => {
    const w = await makeWorld({ consent: false });
    const res = await w.send(ACCEPT);
    expect(res).toEqual({ ok: true, outcome: 'accepted', message: expect.any(String) });
    expect(w.broadcasts).toBe(1);
    const receipt = w.local.data.get(CONSENT_KEY) as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual(['acceptedAt', 'dataPracticesVersion', 'format', 'formatVersion']);
    expect(receipt).toMatchObject({ format: CONSENT_FORMAT, formatVersion: 1, dataPracticesVersion: 1, acceptedAt: expect.stringMatching(/^2026-10-01T/) });
    const sets = w.log.filter((o) => o.type === 'set').length;
    expect(await w.send(ACCEPT)).toMatchObject({ ok: true, outcome: 'already_accepted' });
    expect(await w.send(ACCEPT)).toMatchObject({ ok: true, outcome: 'already_accepted' });
    expect(w.log.filter((o) => o.type === 'set').length).toBe(sets);
    expect(w.local.data.get(CONSENT_KEY)).toEqual(receipt);
    // Agreement alone creates no ledger, report or session.
    expect(recordKeys(w)).toEqual([]);
    expect(w.session.data.size).toBe(0);
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: false });
  });

  it('refuses malformed requests and versions the worker does not display, writing nothing', async () => {
    const w = await makeWorld({ consent: false });
    expect(await w.send({ kind: 'acceptDataPractices', version: 2 })).toMatchObject({ ok: false, error: { code: 'version_mismatch' } });
    expect(await w.send({ kind: 'acceptDataPractices', version: 0 })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await w.send({ kind: 'acceptDataPractices', version: 1, acceptedAt: '2020-01-01T00:00:00.000Z' })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(w.local.data.size).toBe(0);
    expect(w.log.filter((o) => o.type === 'set')).toEqual([]);
  });

  it('a rejected write is reported as not stored; a lost reply is resolved by re-reading the state', async () => {
    const w = await makeWorld({ consent: false });
    w.local.fault = (op) => (op.type === 'set' ? 'reject' : undefined);
    expect(await w.send(ACCEPT)).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('not recorded') } });
    w.local.fault = null;
    expect(await readLedger(w)).toMatchObject({ status: 'consent_required', reason: 'missing' });

    // The worker is stopped after the write committed but before it replied: a fresh read shows the agreement.
    w.local.fault = (op) => (op.type === 'set' ? 'commit-hang' : undefined);
    void w.send(ACCEPT);
    await settle();
    w.local.fault = null;
    w.restartWorker();
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: false });

    // Stopped before the write was applied: a fresh read shows it was not stored.
    const w2 = await makeWorld({ consent: false });
    w2.local.fault = (op) => (op.type === 'set' ? 'hang' : undefined);
    void w2.send(ACCEPT);
    await settle();
    w2.local.fault = null;
    w2.restartWorker();
    expect(await readLedger(w2)).toMatchObject({ status: 'consent_required', reason: 'missing' });
  });

  it('agreement survives worker restarts and browser restarts; Lock does not revoke it; restart still locks the vault', async () => {
    const w = await makeWorld();
    await setUp(w);
    await w.send({ kind: 'lock' });
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    await w.send({ kind: 'unlock', passphrase: PHRASE });
    w.restartWorker();
    expect(await readLedger(w)).toMatchObject({ status: 'ok' });
    w.restartBrowser();
    expect(await readLedger(w)).toEqual({ status: 'locked' });
  });

  it('Lock and the typed erase work without agreement; erase removes the records and the receipt in one step', async () => {
    const w = await makeWorld();
    await setUp(w);
    await w.send({ kind: 'mutate', command: { type: 'loadDemo' } });
    w.local.data.set(CONSENT_KEY, { ...RECEIPT, dataPracticesVersion: 2 });
    w.local.data.set(LEGACY_STORE_KEY, richLegacyLedger());
    expect(await w.send({ kind: 'lock' })).toMatchObject({ ok: true, outcome: 'locked' });
    expect(w.session.data.has(SESSION_KEY)).toBe(false);
    w.log.length = 0;
    expect(await w.send(ERASE)).toMatchObject({ ok: true, outcome: 'erased', message: expect.stringContaining('agreement') });
    const removes = w.log.filter((o) => o.type === 'remove' && o.area === 'local');
    expect(removes).toHaveLength(1);
    expect(removes[0]!.keys).toEqual(expect.arrayContaining([VAULT_KEY, LEGACY_STORE_KEY, CONSENT_KEY]));
    expect([...w.local.data.keys()]).toEqual([ERASE_KEY]);
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'missing', version: 1 });
  });

  it('a rejected erase leaves records and receipt in place, reported as possibly unchanged', async () => {
    const w = await makeWorld();
    await setUp(w);
    w.local.fault = (op) => (op.type === 'remove' ? 'reject' : undefined);
    expect(await w.send(ERASE)).toMatchObject({ ok: false, error: { code: 'write_rejected' } });
    w.local.fault = null;
    expect(w.local.data.has(CONSENT_KEY)).toBe(true);
    expect(w.local.data.has(VAULT_KEY)).toBe(true);
    expect(await readLedger(w)).toEqual({ status: 'locked' });
  });

  it('an erase while agreement is pending cannot make an earlier restore approval valid again', async () => {
    const w = await makeWorld();
    await setUp(w);
    const s = await storedStore(w);
    const approved = { revision: s.revision, stored: true, epoch: s.ledgerEpoch ?? null };
    w.local.data.delete(CONSENT_KEY);
    expect(await w.send(ERASE)).toMatchObject({ ok: true, outcome: 'erased' });
    await agree(w);
    await setUp(w, 'a different synthetic phrase');
    expect(await w.send({ kind: 'restore', operationId: 'op-old', expected: approved, backup: backupEnvelope })).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect((await storedStore(w)).cases).toEqual([]);
  });

  it('the receipt is not part of the ledger: agreeing again changes no revision, receipt or calculation input', async () => {
    const w = await makeWorld();
    await setUp(w);
    const s = await storedStore(w);
    const approved = { revision: s.revision, stored: true, epoch: s.ledgerEpoch ?? null };
    expect(await w.send({ kind: 'restore', operationId: 'op-1', expected: approved, backup: backupEnvelope })).toMatchObject({ ok: true, outcome: 'applied' });
    const restored = await storedStore(w);
    const receipt = structuredClone(w.local.data.get(CONSENT_KEY));
    // Restore neither imports nor changes agreement.
    expect(JSON.stringify(restored)).not.toContain(CONSENT_FORMAT);
    w.local.data.set(CONSENT_KEY, { ...RECEIPT, dataPracticesVersion: 7 });
    await agree(w);
    expect(w.local.data.get(CONSENT_KEY)).not.toEqual(receipt);
    expect(await storedStore(w)).toEqual(restored);
  });
});
