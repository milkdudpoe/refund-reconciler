// Migration of plaintext schema-1 records (0.5.0/0.6.0) into the vault, with a
// fault injected at every awaited storage step: rejected, interrupted (the
// worker "dies" mid-call) or committed and then interrupted (the reply is
// lost). After each, the worker is recreated as after a restart and must show
// a preserved or safely blocked state, never a reset.

import { describe, expect, it } from 'vitest';
import { ERASE_CONFIRMATION } from '../../src/background/messages';
import { LEGACY_STORE_KEY, MIGRATION_KEY, SESSION_KEY, VAULT_KEY } from '../../src/persistence/storage';
import { richLegacyLedger } from '../shared/rich-ledger';
import { PHRASE, makeWorld, readLedger, settle, storedStore, type Fault, type Op, type World } from './vault-fakes';

const migrate = (replaceCandidate = false, passphrase = PHRASE) => ({ kind: 'migrate', passphrase, acknowledged: true, replaceCandidate });

function legacyWorld(): { w: World; legacy: ReturnType<typeof richLegacyLedger> } {
  const w = makeWorld();
  const legacy = richLegacyLedger();
  w.local.data.set(LEGACY_STORE_KEY, structuredClone(legacy));
  return { w, legacy };
}

const describeOp = (o: Op) => `${o.area}.${o.type}(${o.keys.join(',')})`;

describe('migration of an earlier version’s plaintext ledger', () => {
  it('is never silent: valid plaintext data requires migration and blocks ordinary use', async () => {
    const { w, legacy } = legacyWorld();
    expect(await readLedger(w)).toEqual({ status: 'migration_required', stage: 'legacy', legacyCases: legacy.cases.length });
    for (const msg of [{ kind: 'mutate', command: { type: 'loadDemo' } }, { kind: 'mutate', command: { type: 'deleteCase', caseId: 'real-1' } }]) {
      expect(await w.send(msg)).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    }
    expect(await w.send({ kind: 'setup', passphrase: PHRASE, acknowledged: true })).toMatchObject({ ok: false, error: { code: 'wrong_state' } });
    // The read-only exception: the validated plaintext ledger, for a backup before migrating.
    expect(await w.send({ kind: 'readLegacy' })).toEqual({ ok: true, store: legacy });
    expect(w.local.data.get(LEGACY_STORE_KEY)).toEqual(legacy);
    expect(w.log.filter((o) => o.type !== 'get')).toEqual([]);
  });

  it('even an erased (empty) earlier ledger is migrated with its marker, not replaced', async () => {
    const w = makeWorld();
    const erased = { schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: 'old-erase-epoch' };
    w.local.data.set(LEGACY_STORE_KEY, erased);
    expect(await readLedger(w)).toMatchObject({ status: 'migration_required', legacyCases: 0 });
    expect(await w.send(migrate())).toMatchObject({ ok: true, outcome: 'unlocked' });
    expect(await storedStore(w)).toEqual(erased);
  });

  it('preserves every field exactly, verifies before removing the original, in a fixed order', async () => {
    const { w, legacy } = legacyWorld();
    w.log.length = 0;
    expect(await w.send(migrate())).toMatchObject({ ok: true, outcome: 'unlocked' });
    expect(w.log.filter((o) => o.area === 'local' && o.type !== 'bytes').map(describeOp)).toEqual([
      `local.get(${[LEGACY_STORE_KEY, VAULT_KEY, MIGRATION_KEY, 'refundReconciler.erased'].join(',')})`,
      `local.set(${MIGRATION_KEY})`,
      `local.set(${VAULT_KEY})`,
      `local.get(${[LEGACY_STORE_KEY, VAULT_KEY, MIGRATION_KEY].join(',')})`,
      `local.set(${MIGRATION_KEY})`,
      `local.remove(${LEGACY_STORE_KEY})`,
      `local.remove(${MIGRATION_KEY})`,
    ]);
    expect([...w.local.data.keys()]).toEqual([VAULT_KEY]);
    // Exact: ids, timestamps, sources, notes, references, voids, demo flags,
    // capture provenance and parser versions, revision, lastRestore, ledgerEpoch.
    expect(await storedStore(w)).toEqual(legacy);
    expect(JSON.stringify(w.local.data.get(VAULT_KEY))).not.toMatch(/PRIVATE-NOTE|STMT-|Synthetic lamp|amazon-us-selection/);
    // Future writes are encrypted and continue from the migrated revision.
    expect(await w.send({ kind: 'mutate', command: { type: 'deleteCase', caseId: 'real-2' } })).toMatchObject({ ok: true, revision: legacy.revision + 1 });
    w.restartBrowser();
    expect(await readLedger(w)).toEqual({ status: 'locked' });
    await w.send({ kind: 'unlock', passphrase: PHRASE });
    expect((await storedStore(w)).cases.map((c: { id: string }) => c.id)).not.toContain('real-2');
  });

  it('unreadable or unsupported plaintext data is kept intact with recovery information, never migrated', async () => {
    for (const raw of [{ schemaVersion: 1, revision: 'x', cases: [] }, { schemaVersion: 7, cases: [] }]) {
      const w = makeWorld();
      w.local.data.set(LEGACY_STORE_KEY, raw);
      expect(['corrupt', 'unsupported_version']).toContain((await readLedger(w)).status);
      expect(await w.send(migrate())).toMatchObject({ ok: false, error: { code: 'wrong_state' } });
      expect(await w.send({ kind: 'readLegacy' })).toMatchObject({ ok: false });
      expect(w.local.data.get(LEGACY_STORE_KEY)).toEqual(raw);
      expect(w.local.data.size).toBe(1);
    }
  });

  it('insufficient room for both copies keeps the original and writes nothing (no unlimitedStorage)', async () => {
    const { w, legacy } = legacyWorld();
    w.local.quotaBytes = JSON.stringify(legacy).length + 2000;
    expect(await w.send(migrate())).toMatchObject({ ok: false, error: { code: 'insufficient_space', message: expect.stringContaining('intact') } });
    expect([...w.local.data.keys()]).toEqual([LEGACY_STORE_KEY]);
    expect(w.local.data.get(LEGACY_STORE_KEY)).toEqual(legacy);
  });

  // Every awaited storage step of a migration, by position in the operation log.
  const STEPS = ['set marker', 'set vault', 'verify read', 'set verified', 'remove plaintext', 'remove marker', 'session set'] as const;
  const matcher: Record<(typeof STEPS)[number], (o: Op, seen: Op[]) => boolean> = {
    'set marker': (o, seen) => o.area === 'local' && o.type === 'set' && o.keys[0] === MIGRATION_KEY && !seen.some((s) => s.type === 'set' && s.keys[0] === VAULT_KEY),
    'set vault': (o) => o.area === 'local' && o.type === 'set' && o.keys[0] === VAULT_KEY,
    'verify read': (o, seen) => o.area === 'local' && o.type === 'get' && seen.some((s) => s.type === 'set' && s.keys[0] === VAULT_KEY),
    'set verified': (o, seen) => o.area === 'local' && o.type === 'set' && o.keys[0] === MIGRATION_KEY && seen.some((s) => s.type === 'set' && s.keys[0] === VAULT_KEY),
    'remove plaintext': (o) => o.area === 'local' && o.type === 'remove' && o.keys[0] === LEGACY_STORE_KEY,
    'remove marker': (o) => o.area === 'local' && o.type === 'remove' && o.keys[0] === MIGRATION_KEY,
    'session set': (o) => o.area === 'session' && o.type === 'set' && o.keys[0] === SESSION_KEY,
  };

  for (const step of STEPS) {
    for (const fault of ['reject', 'hang', 'commit-hang'] as Fault[]) {
      it(`a ${fault} at "${step}" never loses records and recovers after a restart`, async () => {
        const { w, legacy } = legacyWorld();
        const seen: Op[] = [];
        let fired = false;
        const inject = (o: Op): Fault | undefined => {
          const hit = !fired && matcher[step](o, seen);
          seen.push(o);
          if (hit) fired = true;
          return hit ? fault : undefined;
        };
        w.local.fault = inject;
        w.session.fault = inject;
        const reply = w.send(migrate());
        let res: Record<string, any> | null = null;
        if (fault === 'reject') res = await reply;
        else {
          // The worker is stopped inside this call; its reply is lost.
          for (let i = 0; i < 200 && !fired; i++) await settle();
          await settle();
        }
        expect(fired).toBe(true);
        w.local.fault = null;
        w.session.fault = null;

        if (res) {
          // A definite answer is truthful about what was committed.
          const committedVault = step !== 'set marker' && step !== 'set vault';
          if (!committedVault) expect(res).toMatchObject({ ok: false, error: { code: 'write_rejected' } });
          else if (step === 'verify read') expect(res).toMatchObject({ ok: false, error: { code: 'migration_unverified' } });
          else if (step === 'set verified' || step === 'remove plaintext') expect(res).toMatchObject({ ok: false, error: { code: 'migration_incomplete' } });
          else if (step === 'remove marker') expect(res).toMatchObject({ ok: true, outcome: 'unlocked' });
          else expect(res).toMatchObject({ ok: true, outcome: 'protected_locked' });
        }

        // The original stays until verification; nothing private is lost either way.
        const plaintextLeft = w.local.data.has(LEGACY_STORE_KEY);
        if (plaintextLeft) expect(w.local.data.get(LEGACY_STORE_KEY)).toEqual(legacy);
        else expect(w.local.data.has(VAULT_KEY)).toBe(true);

        w.restartWorker();
        const state = await readLedger(w);
        // Never empty, never "setup required".
        expect(['migration_required', 'migration_pending', 'locked', 'ok']).toContain(state.status);
        if (state.status === 'migration_required') {
          expect(await w.send(migrate(true))).toMatchObject({ ok: true, outcome: 'unlocked' });
        } else if (state.status === 'migration_pending' || state.status === 'locked') {
          // The candidate needs the passphrase again; unlocking verifies and finishes.
          expect(await w.send({ kind: 'unlock', passphrase: PHRASE })).toMatchObject({ ok: true, outcome: 'unlocked' });
        }
        expect(await storedStore(w)).toEqual(legacy);
        if (w.local.data.has(MIGRATION_KEY)) {
          // Only a harmless leftover after verification; the next unlock removes it.
          expect(w.local.data.get(MIGRATION_KEY)).toMatchObject({ phase: 'verified' });
          await w.send({ kind: 'lock' });
          await w.send({ kind: 'unlock', passphrase: PHRASE });
        }
        expect([...w.local.data.keys()]).toEqual([VAULT_KEY]);
      });
    }
  }

  it('a lost reply after a completed migration is resolved by re-reading the state, not by migrating again', async () => {
    const { w, legacy } = legacyWorld();
    await w.send(migrate());
    w.restartWorker();
    expect(await readLedger(w)).toMatchObject({ status: 'ok' });
    // A retried migrate (what a page might send) is refused: nothing is regenerated over the vault.
    const vault = structuredClone(w.local.data.get(VAULT_KEY));
    expect(await w.send(migrate(true))).toMatchObject({ ok: false, error: { code: 'wrong_state' } });
    expect(w.local.data.get(VAULT_KEY)).toEqual(vault);
    expect(await storedStore(w)).toEqual(legacy);
  });

  it('a pending candidate is never replaced without an explicit choice, and an explicit restart keeps the original', async () => {
    const { w, legacy } = legacyWorld();
    w.local.fault = (o) => (o.type === 'get' && w.local.data.has(VAULT_KEY) && o.keys.length === 3 ? 'reject' : undefined);
    expect(await w.send(migrate())).toMatchObject({ ok: false, error: { code: 'migration_unverified' } });
    w.local.fault = null;
    expect(await readLedger(w)).toMatchObject({ status: 'migration_pending', stage: 'candidate' });
    expect(await w.send(migrate(false, 'another phrase entirely'))).toMatchObject({ ok: false, error: { code: 'wrong_state' } });
    // Forgotten phrase for the candidate: start again with a new one (the original is intact).
    const oldVaultId = (w.local.data.get(VAULT_KEY) as { vaultId: string }).vaultId;
    expect(await w.send(migrate(true, 'another phrase entirely'))).toMatchObject({ ok: true, outcome: 'unlocked' });
    expect((w.local.data.get(VAULT_KEY) as { vaultId: string }).vaultId).not.toBe(oldVaultId);
    expect(await storedStore(w)).toEqual(legacy);
  });

  it('a candidate that disagrees with the original is blocked; neither copy is preferred or removed', async () => {
    const { w } = legacyWorld();
    w.local.fault = (o) => (o.type === 'get' && w.local.data.has(VAULT_KEY) && o.keys.length === 3 ? 'reject' : undefined);
    await w.send(migrate());
    w.local.fault = null;
    // The plaintext original changes behind the migration's back (e.g. an older version was run).
    const changed = richLegacyLedger();
    (changed.cases[1] as { orderRef: string | null }).orderRef = 'CHANGED-ELSEWHERE';
    w.local.data.set(LEGACY_STORE_KEY, changed);
    const before = structuredClone([...w.local.data.entries()]);
    expect(await w.send({ kind: 'unlock', passphrase: PHRASE })).toMatchObject({ ok: false, error: { code: 'migration_blocked' } });
    expect([...w.local.data.entries()]).toEqual(before);
    expect(await readLedger(w)).toMatchObject({ status: 'migration_pending' });
    // Recovery: the plaintext backup is still available, and erase is explicit.
    expect(await w.send({ kind: 'readLegacy' })).toEqual({ ok: true, store: changed });
  });

  it('an unreadable candidate beside an intact original allows starting again', async () => {
    const { w, legacy } = legacyWorld();
    w.local.data.set(MIGRATION_KEY, { format: 'refund-reconciler-migration', formatVersion: 1, phase: 'candidate', vaultId: 'v-1' });
    w.local.data.set(VAULT_KEY, { format: 'refund-reconciler-vault', formatVersion: 1, damaged: true });
    expect(await readLedger(w)).toMatchObject({ status: 'migration_required', stage: 'candidate_unreadable' });
    expect(await w.send(migrate(true))).toMatchObject({ ok: true });
    expect(await storedStore(w)).toEqual(legacy);
  });

  it('plaintext beside a completed vault, or a damaged marker, is an inconsistent state that changes nothing until erased', async () => {
    const { w, legacy } = legacyWorld();
    await w.send(migrate());
    w.local.data.set(LEGACY_STORE_KEY, legacy);
    expect(await readLedger(w)).toMatchObject({ status: 'inconsistent', legacyReadable: true });
    expect(await w.send({ kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    expect(await w.send({ kind: 'readLegacy' })).toEqual({ ok: true, store: legacy });
    w.local.data.set(MIGRATION_KEY, { junk: true });
    expect(await readLedger(w)).toMatchObject({ status: 'inconsistent' });
    expect(await w.send({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: true, outcome: 'erased' });
    expect(await readLedger(w)).toEqual({ status: 'setup_required', erased: true });
  });
});
