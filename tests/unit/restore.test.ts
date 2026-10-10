import { describe, expect, it } from 'vitest';
import { ERASE_CONFIRMATION, parseRequest } from '../../src/background/messages';
import { analyzeExcerpt } from '../../src/capture/parse';
import { summarizeCase } from '../../src/domain/reconcile';
import { decideRestore, type RestoreRequest } from '../../src/domain/restore';
import { emptyStore, type StoreData } from '../../src/domain/types';
import { parseBackupEnvelope, parseStore, type ParsedBackup } from '../../src/domain/validate';
import { MAX_BACKUP_BYTES, buildBackup, restorePayloadDigest, serializeBackup } from '../../src/export/backup';
import { VAULT_KEY } from '../../src/persistence/storage';
import { PHRASE, makeWorld, setUp, storedStore, type World } from './vault-fakes';
import { HISTORICAL_REFUSED_EXCERPT, richLedger } from '../shared/rich-ledger';

const EXPORTED_AT = '2026-10-09T08:00:00.000Z';
const NOW = '2026-10-10T12:00:00.000Z';

function envelope(store: unknown = richLedger()): Record<string, unknown> {
  return { format: 'refund-reconciler-backup', formatVersion: 1, exportedAt: EXPORTED_AT, store };
}

function mustParse(v: unknown): ParsedBackup {
  const r = parseBackupEnvelope(v);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function request(operationId = 'op-1', expected: { revision: number; stored: boolean; epoch: string | null } = { revision: 0, stored: false, epoch: null }, backup: unknown = envelope()) {
  return { kind: 'restore', operationId, expected, backup };
}

describe('backup file validation', () => {
  it('accepts a Task 03 backup exactly as exported, including historical captures the current parser refuses', () => {
    const source = richLedger();
    const text = serializeBackup(buildBackup(source as unknown as StoreData, EXPORTED_AT));
    const parsed = mustParse(JSON.parse(text));
    expect(JSON.parse(JSON.stringify(parsed.store))).toEqual(source);
    expect(analyzeExcerpt(HISTORICAL_REFUSED_EXCERPT).issued).toBeNull();
    const hist = parsed.store.cases[0]?.entries.find((e) => e.id === 'cap-hist');
    expect(hist).toMatchObject({ amountCents: 3500, capture: { parserVersion: 'amazon-us-selection-1', excerpt: HISTORICAL_REFUSED_EXCERPT } });
  });

  const bad: [string, () => unknown, RegExp][] = [
    ['not an object', () => [], /not a Refund Reconciler backup/],
    ['wrong format', () => ({ ...envelope(), format: 'other-app' }), /not a Refund Reconciler backup/],
    ['wrong version', () => ({ ...envelope(), formatVersion: 2 }), /format version 2/],
    ['string version', () => ({ ...envelope(), formatVersion: '1' }), /format version "1"/],
    ['extra envelope field', () => ({ ...envelope(), script: 'alert(1)' }), /unexpected field\(s\): script/],
    ['bad exportedAt', () => ({ ...envelope(), exportedAt: 'yesterday' }), /exportedAt/],
    ['impossible exportedAt', () => ({ ...envelope(), exportedAt: '2026-13-45T00:00:00Z' }), /exportedAt/],
    ['missing store', () => { const e = envelope(); delete e.store; return e; }, /no "store"/],
    ['unsupported ledger', () => envelope({ schemaVersion: 2, revision: 1, cases: [] }), /schema version 2/],
    ['fractional cents', () => { const s = richLedger(); (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = 12.5; return envelope(s); }, /amountCents/],
    ['negative cents', () => { const s = richLedger(); (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = -100; return envelope(s); }, /amountCents/],
    ['string cents', () => { const s = richLedger(); (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = '20.00'; return envelope(s); }, /amountCents/],
    ['duplicate case id', () => { const s = richLedger(); s.cases.push(structuredClone(s.cases[0]!)); return envelope(s); }, /duplicate case id|more than one case/],
    ['duplicate entry id', () => { const s = richLedger(); const es = (s.cases[0] as { entries: Record<string, unknown>[] }).entries; es.push({ ...es[1]! }); return envelope(s); }, /duplicate entry id/],
    ['void of unknown entry', () => { const s = richLedger(); const es = (s.cases[0] as { entries: Record<string, unknown>[] }).entries; es.find((e) => e.id === 'v1')!.targetEntryId = 'nope'; return envelope(s); }, /targetEntryId/],
    ['bad id characters', () => { const s = richLedger(); s.cases[0]!.id = '<b>x</b>'; return envelope(s); }, /id/],
    ['provenance amount mismatch', () => { const s = richLedger(); const es = (s.cases[0] as { entries: Record<string, unknown>[] }).entries; es.find((e) => e.id === 'cap-new')!.amountCents = 3600; return envelope(s); }, /approvedAmountText/],
    ['provenance foreign origin', () => { const s = richLedger(); const es = (s.cases[0] as { entries: { id: string; capture?: Record<string, unknown> }[] }).entries; es.find((e) => e.id === 'cap-new')!.capture!.sourceOrigin = 'https://evil.example'; return envelope(s); }, /sourceOrigin/],
    ['unknown parser version', () => { const s = richLedger(); const es = (s.cases[0] as { entries: { id: string; capture?: Record<string, unknown> }[] }).entries; es.find((e) => e.id === 'cap-new')!.capture!.parserVersion = 'made-up-9'; return envelope(s); }, /unknown capture parser version/],
    ['over-long note', () => { const s = richLedger(); (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.note = 'x'.repeat(1001); return envelope(s); }, /longer than 1000/],
    ['bad restore receipt', () => envelope({ ...richLedger(), lastRestore: { operationId: 'x' } }), /lastRestore/],
  ];
  for (const [name, make, message] of bad) {
    it(`rejects ${name}`, () => {
      const r = parseBackupEnvelope(make());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(message);
    });
  }

  it('documents a 25 MiB input bound', () => {
    expect(MAX_BACKUP_BYTES).toBe(25 * 1024 * 1024);
  });

  it('keeps existing schema-1 stores valid and validates the optional restore receipt on every read', () => {
    const plain = richLedger();
    expect(parseStore(plain).status).toBe('ok');
    const receipt = { operationId: 'op-1', payloadSha256: 'a'.repeat(64), restoredAt: NOW, restoredRevision: 1, sourceExportedAt: EXPORTED_AT, sourceRevision: 9, caseCount: 1 };
    expect(parseStore({ ...plain, revision: 3, lastRestore: receipt }).status).toBe('ok');
    expect(parseStore({ ...plain, revision: 3, lastRestore: { ...receipt, restoredRevision: 4 } }).status).toBe('corrupt');
    expect(parseStore({ ...plain, revision: 3, lastRestore: { ...receipt, payloadSha256: 'xyz' } }).status).toBe('corrupt');
    expect(parseStore({ ...plain, revision: 3, lastRestore: { ...receipt, extra: 1 } }).status).toBe('corrupt');
    const missing: Partial<typeof receipt> = { ...receipt };
    delete missing.caseCount;
    expect(parseStore({ ...plain, revision: 3, lastRestore: missing }).status).toBe('corrupt');
  });
});

describe('decideRestore', () => {
  const req = (overrides: Partial<RestoreRequest> = {}): RestoreRequest => ({ operationId: 'op-1', expected: { revision: 0, stored: false, epoch: null }, backup: mustParse(envelope()), ...overrides });

  it('restores every case unchanged into an empty ledger with the next revision and a receipt', () => {
    const r = req();
    const d = decideRestore(emptyStore(), false, r, 'f'.repeat(64), NOW);
    if (d.kind !== 'write') throw new Error(d.kind);
    expect(d.store.cases).toEqual(r.backup.store.cases);
    expect(d.store.revision).toBe(1); // the backup's own revision is not applied to the counter
    expect(d.store.lastRestore).toEqual({ operationId: 'op-1', payloadSha256: 'f'.repeat(64), restoredAt: NOW, restoredRevision: 1, sourceExportedAt: EXPORTED_AT, sourceRevision: r.backup.store.revision, caseCount: 4 });
    // Derived financial state is identical.
    for (const [i, c] of d.store.cases.entries()) expect(summarizeCase(c)).toEqual(summarizeCase(r.backup.store.cases[i]!));
    // Validates as stored data.
    expect(parseStore(JSON.parse(JSON.stringify(d.store))).status).toBe('ok');
  });

  it('continues an existing empty ledger’s counter', () => {
    const d = decideRestore({ ...emptyStore(), revision: 7 }, true, req({ expected: { revision: 7, stored: true, epoch: null } }), 'f'.repeat(64), NOW);
    expect(d.kind === 'write' && d.store.revision).toBe(8);
  });

  it('never carries an imported receipt into the destination', () => {
    const source = { ...richLedger(), revision: 12, lastRestore: { operationId: 'op-1', payloadSha256: 'f'.repeat(64), restoredAt: NOW, restoredRevision: 12, sourceExportedAt: EXPORTED_AT, sourceRevision: 3, caseCount: 4 } };
    const r = req({ backup: mustParse(envelope(source)) });
    // The imported receipt names the same id, but it is source metadata: the destination is empty, so the restore is written fresh.
    const d = decideRestore(emptyStore(), false, r, 'e'.repeat(64), NOW);
    if (d.kind !== 'write') throw new Error(d.kind);
    expect(d.store.lastRestore).toMatchObject({ operationId: 'op-1', payloadSha256: 'e'.repeat(64), restoredAt: NOW, sourceRevision: 12 });
  });

  it('refuses non-empty, stale or never-written-vs-written destinations, and recognises its own receipt', () => {
    const backup = mustParse(envelope());
    const demoOnly = { ...emptyStore(), revision: 1, cases: backup.store.cases.filter((c) => c.isDemo) };
    expect(decideRestore(demoOnly, true, req({ expected: { revision: 1, stored: true, epoch: null } }), 'f'.repeat(64), NOW)).toMatchObject({ kind: 'refused', code: 'restore_not_empty' });
    expect(decideRestore({ ...emptyStore(), revision: 3 }, true, req({ expected: { revision: 2, stored: true, epoch: null } }), 'f'.repeat(64), NOW)).toMatchObject({ kind: 'refused', code: 'restore_stale' });
    expect(decideRestore(emptyStore(), true, req(), 'f'.repeat(64), NOW)).toMatchObject({ kind: 'refused', code: 'restore_stale' });
    expect(decideRestore(emptyStore(), false, req({ expected: { revision: 0, stored: true, epoch: null } }), 'f'.repeat(64), NOW)).toMatchObject({ kind: 'refused', code: 'restore_stale' });

    const written = decideRestore(emptyStore(), false, req(), 'f'.repeat(64), NOW);
    if (written.kind !== 'write') throw new Error(written.kind);
    // Later edits do not matter: the receipt identifies the committed operation.
    const edited = { ...written.store, revision: 5, cases: [] };
    expect(decideRestore(edited, true, req(), 'f'.repeat(64), NOW)).toEqual({ kind: 'already_restored', revision: 5 });
    expect(decideRestore(edited, true, req(), '0'.repeat(64), NOW)).toMatchObject({ kind: 'refused', code: 'conflict' });
  });

  it('treats an empty backup as a no-op', () => {
    const r = req({ backup: mustParse(envelope({ schemaVersion: 1, revision: 4, cases: [] })) });
    expect(decideRestore({ ...emptyStore(), revision: 2 }, true, r, 'f'.repeat(64), NOW)).toEqual({ kind: 'empty_backup', revision: 2 });
  });

  it('digests contents, not ids alone', async () => {
    const a = mustParse(envelope());
    const changed = richLedger();
    (changed.cases[1] as { entries: Record<string, unknown>[] }).entries[1]!.note = 'edited';
    const b = mustParse(envelope(changed));
    const da = await restorePayloadDigest(a.exportedAt, a.store);
    expect(da).toMatch(/^[0-9a-f]{64}$/);
    expect(await restorePayloadDigest(a.exportedAt, a.store)).toBe(da);
    expect(await restorePayloadDigest(b.exportedAt, b.store)).not.toBe(da);
    expect(await restorePayloadDigest('2026-01-01T00:00:00.000Z', a.store)).not.toBe(da);
  });
});

describe('restore through the service worker handler (encrypted ledger)', () => {
  async function unlocked(): Promise<World> {
    const w = makeWorld();
    await setUp(w);
    return w;
  }
  /** The approval token for the destination as it is now. */
  async function token(w: World): Promise<{ revision: number; stored: boolean; epoch: string | null }> {
    const s = (await storedStore(w)) as StoreData;
    return { revision: s.revision, stored: true, epoch: s.ledgerEpoch ?? null };
  }
  const vaultWrites = (w: World) => w.log.filter((o) => o.type === 'set' && o.keys.includes(VAULT_KEY)).length;
  const ERASE = { kind: 'eraseAll', confirm: ERASE_CONFIRMATION };

  it('validates forged messages at the worker boundary and writes nothing', async () => {
    const w = await unlocked();
    const s = richLedger();
    (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = 1.5;
    const t = await token(w);
    const forged = [
      request('op-1', t, envelope(s)),
      request('op 1', t),
      request('op-1', { revision: -1, stored: true, epoch: null }),
      { ...request('op-1', t), extra: true },
      request('op-1', t, { ...envelope(), formatVersion: 9 }),
      { kind: 'restore', operationId: 'op-1', expected: t },
    ];
    const writes = vaultWrites(w);
    for (const msg of forged) expect(await w.send(msg)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(vaultWrites(w)).toBe(writes);
    expect((await storedStore(w)).cases).toEqual([]);
    expect(parseRequest({ kind: 'restore' }).ok).toBe(false);
  });

  it('restores only into an empty, unlocked ledger: locked, unset and migration-pending destinations are refused', async () => {
    const w = makeWorld();
    expect(await w.send(request('op-1', { revision: 0, stored: true, epoch: null }))).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    await setUp(w);
    const t = await token(w);
    await w.send({ kind: 'lock' });
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: false, error: { code: 'vault_locked' } });
    await w.send({ kind: 'unlock', passphrase: PHRASE });
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
  });

  it('applies once; identical retries, restarts and later edits never duplicate or overwrite', async () => {
    const w = await unlocked();
    const t = await token(w);
    expect(await w.send(request('op-1', t))).toEqual({ ok: true, outcome: 'applied', revision: 1 });
    const restored = (await storedStore(w)) as StoreData;
    expect(JSON.parse(JSON.stringify(restored.cases))).toEqual(richLedger().cases);
    expect(restored.lastRestore).toMatchObject({ operationId: 'op-1', restoredAt: expect.any(String), caseCount: richLedger().cases.length });
    await w.send({ kind: 'mutate', command: { type: 'recordEntry', caseId: 'real-2', entry: { id: 'later', kind: 'receipt', itemId: 'c', amountCents: 100, occurredOn: null, source: 'Manual', note: '', reference: null } } });
    const afterEdit = await storedStore(w);
    w.restartWorker();
    expect(await w.send(request('op-1', t))).toEqual({ ok: true, outcome: 'duplicate', revision: 2 });
    const other = richLedger();
    other.cases.pop();
    expect(await w.send(request('op-1', t, envelope(other)))).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await w.send(request('op-2', t))).toMatchObject({ ok: false, error: { code: 'restore_not_empty' } });
    expect(await storedStore(w)).toEqual(afterEdit);
  });

  it('a rejected write changes nothing and an identical retry can succeed', async () => {
    const w = await unlocked();
    const t = await token(w);
    w.local.fault = (o) => (o.type === 'set' ? 'reject' : undefined);
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('nothing was restored') } });
    w.local.fault = null;
    expect((await storedStore(w)).cases).toEqual([]);
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: true, outcome: 'applied' });
  });

  it('never treats corrupt, unsupported, unreadable or locked storage as empty', async () => {
    for (const raw of [{ schemaVersion: 1, revision: 'x', cases: [] }, { schemaVersion: 99, revision: 1, cases: [] }, 'garbage']) {
      const w = makeWorld();
      w.local.data.set('refundReconciler.store', raw);
      expect((await w.send(request('op-1', { revision: 0, stored: true, epoch: null }))).ok).toBe(false);
      expect(w.local.data.get('refundReconciler.store')).toEqual(raw);
      expect(w.local.data.size).toBe(1);
    }
    const w = await unlocked();
    const t = await token(w);
    w.local.fault = (o) => (o.type === 'get' ? 'reject' : undefined);
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    w.local.fault = null;
    // Damaged ciphertext with a valid session key: unreadable, never empty.
    const v = structuredClone(w.local.data.get(VAULT_KEY)) as { payload: { ciphertext: string } };
    v.payload.ciphertext = `${v.payload.ciphertext[0] === 'A' ? 'B' : 'A'}${v.payload.ciphertext.slice(1)}`;
    w.local.data.set(VAULT_KEY, v);
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: false, error: { code: 'storage_unreadable' } });
  });

  it('serialises concurrent restores: exactly one complete ledger, never a mix', async () => {
    const w = await unlocked();
    const t = await token(w);
    const other = { schemaVersion: 1, revision: 3, cases: [richLedger().cases[1]] };
    const [a, b] = await Promise.all([w.send(request('op-a', t)), w.send(request('op-b', t, envelope(other)))]);
    expect(a).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
    expect(b).toMatchObject({ ok: false, error: { code: 'restore_not_empty' } });
    expect(JSON.parse(JSON.stringify((await storedStore(w)).cases))).toEqual(richLedger().cases);
  });

  it('an empty backup is a no-op that writes nothing', async () => {
    const w = await unlocked();
    const writes = vaultWrites(w);
    expect(await w.send(request('op-1', await token(w), envelope({ schemaVersion: 1, revision: 0, cases: [] })))).toEqual({ ok: true, outcome: 'unchanged', revision: 0 });
    expect(vaultWrites(w)).toBe(writes);
  });

  it('deleting restored cases, or erasing and setting up again, never lets an old retry resurrect them', async () => {
    const w = await unlocked();
    const t = await token(w);
    await w.send(request('op-1', t));
    for (const id of ['real-1', 'real-2']) await w.send({ kind: 'mutate', command: { type: 'deleteCase', caseId: id } });
    await w.send({ kind: 'mutate', command: { type: 'removeDemo' } });
    const emptied = await storedStore(w);
    expect(emptied.cases).toHaveLength(0);
    expect(await w.send(request('op-1', t))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(await storedStore(w)).toEqual(emptied);

    const approvedNow = await token(w);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await w.send(ERASE)).toMatchObject({ ok: true, outcome: 'erased' });
      w.restartWorker();
      await setUp(w, `fresh phrase number ${cycle}`);
      // Same request, same id, same original token, sent to a new handler instance.
      expect(await w.send(request('op-1', t))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
      expect(await w.send(request('op-2', approvedNow))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
      expect((await storedStore(w)).cases).toEqual([]);
    }
    const fresh = await token(w);
    expect(await w.send(request('op-new', fresh))).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
    expect(await w.send(request('op-new', fresh))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect((await storedStore(w)).lastRestore?.operationId).toBe('op-new');
  });

  it('keeps the destination marker through mutations, deletion and restore; never imports a backup’s marker', async () => {
    const w = await unlocked();
    const destEpoch = (await storedStore(w)).ledgerEpoch;
    await w.send({ kind: 'mutate', command: { type: 'loadDemo' } });
    await w.send({ kind: 'mutate', command: { type: 'removeDemo' } });
    expect(await storedStore(w)).toMatchObject({ ledgerEpoch: destEpoch, revision: 2 });
    const source = { ...richLedger(), ledgerEpoch: 'source-epoch' };
    expect(await w.send(request('op-1', { revision: 2, stored: true, epoch: 'source-epoch' }, envelope(source)))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(await w.send(request('op-1', { revision: 2, stored: false, epoch: destEpoch }, envelope(source)))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(await w.send(request('op-1', { revision: 2, stored: true, epoch: destEpoch }, envelope(source)))).toMatchObject({ ok: true, outcome: 'applied' });
    expect((await storedStore(w)).ledgerEpoch).toBe(destEpoch);
    await w.send({ kind: 'mutate', command: { type: 'deleteCase', caseId: 'real-1' } });
    expect((await storedStore(w)).ledgerEpoch).toBe(destEpoch);
    expect(parseStore({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: 'bad epoch!' }).status).toBe('corrupt');
    expect(parseRequest(request('op-9', { revision: 0, stored: true, epoch: 5 } as never)).ok).toBe(false);
    expect(parseRequest(request('op-9', { revision: 0, stored: true } as never)).ok).toBe(false);
  });
});
