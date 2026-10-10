// Service-worker handler: the ledger rules from earlier tasks, now applied to
// the encrypted vault. Storage areas are in-memory fakes (tests/unit/vault-fakes.ts);
// all encryption is real WebCrypto with the production work factor.

import { describe, expect, it } from 'vitest';
import { ERASE_CONFIRMATION } from '../../src/background/messages';
import { ERASE_KEY, GENERATION_KEY, LEGACY_STORE_KEY, SESSION_KEY, VAULT_KEY } from '../../src/persistence/storage';
import { PHRASE, agree, makeWorld, readLedger, setUp, storedStore, type World, recordKeys } from './vault-fakes';

const create = (caseId: string, expectedCents = 3500) => ({
  kind: 'mutate',
  command: { type: 'createCase', caseId, orderRef: null, items: [{ itemId: `${caseId}-a`, label: 'Item', expectedCents, expectationEntryId: `${caseId}-e` }] },
});
const receipt = (caseId: string, id: string, amountCents = 3500) => ({
  kind: 'mutate',
  command: { type: 'recordEntry', caseId, entry: { id, kind: 'receipt', itemId: `${caseId}-a`, amountCents, occurredOn: null, source: 'Manual', note: '', reference: null } },
});

async function unlockedWorld(): Promise<World> {
  const w = await makeWorld();
  await setUp(w);
  return w;
}

function rejectVaultWrites(w: World, on: boolean): void {
  w.local.fault = on ? (op) => (op.type === 'set' && op.keys.includes(VAULT_KEY) ? 'reject' : undefined) : null;
}

describe('service worker handler (encrypted ledger)', () => {
  it('a fresh installation requires setup and refuses every change until then', async () => {
    const w = await makeWorld();
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: false });
    expect(await w.send(create('c1'))).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    expect(await w.send({ kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    expect(recordKeys(w).length).toBe(0);
  });

  it('persists encrypted and reports success only after the write', async () => {
    const w = await unlockedWorld();
    expect(await storedStore(w)).toMatchObject({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: expect.any(String) });
    expect(await w.send(create('c1'))).toEqual({ ok: true, outcome: 'applied', revision: 1 });
    expect((await storedStore(w)).cases).toHaveLength(1);
    // Nothing readable in persistent storage: only the vault envelope.
    expect(recordKeys(w)).toEqual([VAULT_KEY]);
    expect(JSON.stringify([...w.local.data.values()])).not.toMatch(/c1-a|Item|3500|schemaVersion/);
  });

  it('a rejected write is reported as not saved and leaves the old state intact; a retry uses a fresh IV', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1', 7000));
    const before = structuredClone(w.local.data.get(VAULT_KEY));
    rejectVaultWrites(w, true);
    const res = await w.send(receipt('c1', 'r1', 7000));
    expect(res).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('not saved') } });
    expect(w.local.data.get(VAULT_KEY)).toEqual(before);
    rejectVaultWrites(w, false);
    expect(await w.send(receipt('c1', 'r1', 7000))).toMatchObject({ ok: true, outcome: 'applied' });
    expect((await storedStore(w)).cases[0].entries.filter((e: { kind: string }) => e.kind === 'receipt')).toHaveLength(1);
  });

  it('a committed write is reported as saved even if storage cannot be read afterwards', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1', 7000));
    let broken = false;
    w.local.fault = (op) => {
      if (broken && op.type === 'get') return 'reject';
      if (op.type === 'set') broken = true;
      return undefined;
    };
    expect(await w.send(receipt('c1', 'stable-id', 7000))).toEqual({ ok: true, outcome: 'applied', revision: 2 });
    w.local.fault = null;
    const store = await storedStore(w);
    expect(store.revision).toBe(2);
    // The same id again (what a page sends after a lost reply) is a duplicate: no second write.
    const sets = w.log.filter((o) => o.type === 'set').length;
    expect(await w.send(receipt('c1', 'stable-id', 7000))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(w.log.filter((o) => o.type === 'set').length).toBe(sets);
  });

  it('a read failure before writing reports that no change was attempted', async () => {
    const w = await unlockedWorld();
    // The records cannot be read (the consent receipt still can).
    w.local.fault = (op) => (op.type === 'get' && op.keys.includes(VAULT_KEY) ? 'reject' : undefined);
    expect(await w.send(create('c1'))).toMatchObject({ ok: false, error: { code: 'storage_error', message: expect.stringContaining('no change was attempted') } });
    expect(await readLedger(w)).toMatchObject({ status: 'storage_error' });
  });

  it('serialises concurrent writes from multiple views so none are lost', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1', 10_000));
    const results = await Promise.all([w.send(receipt('c1', 'r1', 1000)), w.send(receipt('c1', 'r2', 2000)), w.send(create('c2')), w.send(receipt('c1', 'r3', 3000))]);
    expect(results.every((r) => r.ok)).toBe(true);
    const store = await storedStore(w);
    expect(store.cases.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2']);
    expect(store.cases[0].entries.filter((e: { kind: string }) => e.kind === 'receipt').map((e: { id: string }) => e.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('rejects invalid messages before touching storage', async () => {
    const w = await unlockedWorld();
    const before = w.log.length;
    expect(await w.send(receipt('c1', 'r1', -5))).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await w.send({ kind: 'read', extra: 1 })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await w.send({ kind: 'setup', passphrase: PHRASE })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: 'yes' })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(await w.send({ kind: 'eraseAll', confirm: 'please' })).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(w.log.length).toBe(before);
  });

  it('if storage cannot be restricted to trusted contexts, nothing is read, written, unlocked or kept in the session', async () => {
    const w = await makeWorld();
    w.access.fail = true;
    expect(await readLedger(w)).toMatchObject({ status: 'storage_unavailable' });
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'storage_unavailable' } });
    expect(w.log).toEqual([]);
    w.access.fail = false;
    await setUp(w);
    w.access.fail = true;
    w.restartWorker();
    expect(await w.send(create('c1'))).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(await w.send({ kind: 'unlock', passphrase: PHRASE })).toMatchObject({ ok: false, error: { code: 'storage_unavailable' } });
  });
});

describe('passphrase setup, unlock and Lock', () => {
  it('enforces the documented passphrase rules exactly, without trimming or normalising', async () => {
    const w = await makeWorld();
    for (const bad of ['elevenchars', 'x'.repeat(1025), `${'a'.repeat(12)}\uD800`, 'é'.repeat(513)]) {
      expect(await w.send({ kind: 'setup', passphrase: bad, acknowledged: true })).toMatchObject({ ok: false });
    }
    expect(recordKeys(w).length).toBe(0);
    // 12 code points (emoji are one code point each, two UTF-16 units) is enough.
    const emoji = '🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒';
    expect(await w.send({ kind: 'setup', passphrase: emoji, acknowledged: true })).toMatchObject({ ok: true, outcome: 'unlocked' });
    await w.send({ kind: 'lock' });
    // Leading/trailing spaces and composition are significant: these are different phrases.
    expect(await w.send({ kind: 'unlock', passphrase: ` ${emoji}` })).toMatchObject({ ok: false, error: { code: 'unlock_failed' } });
    expect(await w.send({ kind: 'unlock', passphrase: emoji })).toMatchObject({ ok: true, outcome: 'unlocked' });
    const w2 = await makeWorld();
    await setUp(w2, 'café au lait twelve');
    await w2.send({ kind: 'lock' });
    expect(await w2.send({ kind: 'unlock', passphrase: 'café au lait twelve' })).toMatchObject({ ok: false, error: { code: 'unlock_failed' } });
  });

  it('never stores the passphrase or the unwrapped key persistently; the session record is bound to the vault and generation', async () => {
    const w = await unlockedWorld();
    const persistent = JSON.stringify([...w.local.data.entries()]);
    expect(persistent).not.toContain(PHRASE);
    const record = w.session.data.get(SESSION_KEY) as { key: string; vaultId: string; generation: string };
    expect(persistent).not.toContain(record.key);
    expect(record.generation).toBe(w.session.data.get(GENERATION_KEY));
    expect(record.vaultId).toBe((w.local.data.get(VAULT_KEY) as { vaultId: string }).vaultId);
    expect(JSON.stringify([...w.session.data.values()])).not.toContain(PHRASE);
  });

  it('Lock now revokes the session; later reads and writes cannot use it, and the old record is refused even if put back', async () => {
    const w = await unlockedWorld();
    const oldRecord = structuredClone(w.session.data.get(SESSION_KEY));
    expect(await w.send({ kind: 'lock' })).toMatchObject({ ok: true, outcome: 'locked' });
    expect(w.broadcasts).toBeGreaterThan(0);
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    expect(await w.send(create('c1'))).toMatchObject({ ok: false, error: { code: 'vault_locked' } });
    // A stale record (e.g. written by a slow unlock) carries the old generation and is never accepted.
    w.session.data.set(SESSION_KEY, oldRecord);
    w.restartWorker();
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    expect(await w.send({ kind: 'unlock', passphrase: PHRASE })).toMatchObject({ ok: true, outcome: 'unlocked' });
    expect(await readLedger(w)).toMatchObject({ status: 'ok' });
  });

  it('a wrong passphrase gives an honest retry message and changes nothing', async () => {
    const w = await unlockedWorld();
    await w.send({ kind: 'lock' });
    const before = structuredClone([...w.local.data.entries()]);
    const res = await w.send({ kind: 'unlock', passphrase: 'not the right phrase' });
    expect(res).toMatchObject({ ok: false, error: { code: 'unlock_failed', message: expect.stringContaining('cannot be told apart') } });
    expect([...w.local.data.entries()]).toEqual(before);
    expect(await readLedger(w)).toEqual({ status: 'locked' });
  });

  it('a service-worker restart keeps the session; a browser restart or extension reload requires the passphrase again', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1'));
    w.restartWorker();
    expect((await storedStore(w)).cases).toHaveLength(1);
    expect(await w.send(receipt('c1', 'r1'))).toMatchObject({ ok: true });
    w.restartBrowser();
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    await w.send({ kind: 'unlock', passphrase: PHRASE });
    expect((await storedStore(w)).cases[0].entries).toHaveLength(2);
  });

  it('a write queued before Lock commits; one queued after Lock is refused', async () => {
    const w = await unlockedWorld();
    const [a, l, b] = await Promise.all([w.send(create('c1')), w.send({ kind: 'lock' }), w.send(create('c2'))]);
    expect(a).toMatchObject({ ok: true, outcome: 'applied' });
    expect(l).toMatchObject({ ok: true, outcome: 'locked' });
    expect(b).toMatchObject({ ok: false, error: { code: 'vault_locked' } });
    await w.send({ kind: 'unlock', passphrase: PHRASE });
    expect((await storedStore(w)).cases.map((c: { id: string }) => c.id)).toEqual(['c1']);
  });

  it('a slow unlock racing Lock or erase cannot restore a revoked session', async () => {
    const w = await unlockedWorld();
    await w.send({ kind: 'lock' });
    // Unlock (600,000-iteration derivation) is queued first; Lock and a read after it.
    const [u, l, r] = await Promise.all([w.send({ kind: 'unlock', passphrase: PHRASE }), w.send({ kind: 'lock' }), w.send({ kind: 'read' })]);
    expect(u).toMatchObject({ ok: true, outcome: 'unlocked' });
    expect(l).toMatchObject({ ok: true, outcome: 'locked' });
    expect(r).toMatchObject({ ok: true, ledger: { status: 'locked' } });
    const [u2, e, r2] = await Promise.all([w.send({ kind: 'unlock', passphrase: PHRASE }), w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION }), w.send(create('c9'))]);
    expect(u2).toMatchObject({ ok: true });
    expect(e).toMatchObject({ ok: true, outcome: 'erased' });
    // The erase also removed the agreement, so the change is refused at the consent gate.
    expect(r2).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(w.session.data.has(SESSION_KEY)).toBe(false);
  });

  it('a session-storage failure during setup or unlock stops safely without keeping the key anywhere', async () => {
    const w = await makeWorld();
    w.session.fault = () => 'reject';
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'session_unavailable' } });
    expect(recordKeys(w).length).toBe(0);
    w.session.fault = null;
    await setUp(w);
    await w.send({ kind: 'lock' });
    // Generation readable, but the session record cannot be written: correct phrase, still locked, nothing persisted.
    w.session.fault = (op) => (op.type === 'set' && op.keys.includes(SESSION_KEY) ? 'reject' : undefined);
    expect(await w.send({ kind: 'unlock', passphrase: PHRASE })).toMatchObject({ ok: false, error: { code: 'session_unavailable' } });
    w.session.fault = null;
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    expect(JSON.stringify([...w.local.data.values()])).not.toContain(PHRASE);
  });
});

describe('erase', () => {
  it('a locked vault can be erased only with explicit confirmation; erase leaves a fresh nonprivate marker and revokes the session', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1'));
    const oldVaultId = (w.local.data.get(VAULT_KEY) as { vaultId: string }).vaultId;
    const oldRecord = structuredClone(w.session.data.get(SESSION_KEY));
    await w.send({ kind: 'lock' });
    expect(await w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: true, outcome: 'erased' });
    expect(recordKeys(w)).toEqual([ERASE_KEY]);
    expect(w.local.data.get(ERASE_KEY)).toEqual({ format: 'refund-reconciler-erased', formatVersion: 1, epoch: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) });
    // The erase removed the agreement too: the data practices are shown again before setup.
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'missing', version: 1 });
    await agree(w);
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: true });

    // Re-setup creates a new vault identity whose ledger carries the erase marker; an old session record is never accepted.
    const epoch = (w.local.data.get(ERASE_KEY) as { epoch: string }).epoch;
    await setUp(w, 'a completely new phrase');
    const store = await storedStore(w);
    expect(store).toEqual({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: epoch });
    expect((w.local.data.get(VAULT_KEY) as { vaultId: string }).vaultId).not.toBe(oldVaultId);
    w.session.data.set(SESSION_KEY, oldRecord);
    w.restartWorker();
    expect(await readLedger(w)).toEqual({ status: 'locked' });
  });

  it('a rejected erase reports that records may be unchanged; a missing marker is reported, not hidden', async () => {
    const w = await unlockedWorld();
    await w.send(create('c1'));
    w.local.fault = (op) => (op.type === 'remove' ? 'reject' : undefined);
    expect(await w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('may be unchanged') } });
    expect(w.local.data.has(VAULT_KEY)).toBe(true);
    // The session was revoked first, so the records are now locked, not lost.
    w.local.fault = null;
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    w.local.fault = (op) => (op.type === 'set' ? 'reject' : undefined);
    expect(await w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: false, error: { code: 'erase_incomplete' } });
    w.local.fault = null;
    expect(recordKeys(w).length).toBe(0);
    expect(await readLedger(w)).toEqual({ status: 'consent_required', reason: 'missing', version: 1 });
    await agree(w);
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: false });
  });

  it('erases unreadable plaintext and vault data without reading it', async () => {
    for (const [key, raw] of [
      [LEGACY_STORE_KEY, { schemaVersion: 1, revision: 'NaN', cases: [{ id: 'secret', note: 'PRIVATE' }] }],
      [LEGACY_STORE_KEY, { schemaVersion: 99, revision: 3 }],
      [VAULT_KEY, { format: 'refund-reconciler-vault', formatVersion: 1, junk: 'PRIVATE' }],
    ] as const) {
      const w = await makeWorld();
      w.local.data.set(key, raw);
      const state = await readLedger(w);
      expect(['corrupt', 'unsupported_version', 'vault_unreadable']).toContain(state.status);
      // Never treated as empty: no change is possible.
      expect(await w.send(create('c1'))).toMatchObject({ ok: false });
      expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'wrong_state' } });
      expect(w.local.data.get(key)).toEqual(raw);
      expect(await w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: true });
      expect(JSON.stringify([...w.local.data.values()])).not.toMatch(/secret|PRIVATE/);
    }
  });
});
