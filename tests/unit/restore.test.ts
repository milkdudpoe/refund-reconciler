import { describe, expect, it } from 'vitest';
import { createHandler } from '../../src/background/handler';
import { ERASE_CONFIRMATION, parseRequest } from '../../src/background/messages';
import { analyzeExcerpt } from '../../src/capture/parse';
import { summarizeCase } from '../../src/domain/reconcile';
import { decideRestore, type RestoreRequest } from '../../src/domain/restore';
import { emptyStore, type StoreData } from '../../src/domain/types';
import { parseBackupEnvelope, parseStore, type ParsedBackup } from '../../src/domain/validate';
import { MAX_BACKUP_BYTES, buildBackup, restorePayloadDigest, serializeBackup } from '../../src/export/backup';
import { STORE_KEY, type StorageAreaLike } from '../../src/persistence/storage';
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

class FakeArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  failSets = false;
  failGets = false;
  setCalls = 0;
  async get(key: string) {
    await Promise.resolve();
    if (this.failGets) throw new Error('read failed');
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
  }
  async set(items: Record<string, unknown>) {
    this.setCalls += 1;
    await new Promise((r) => setTimeout(r, 1));
    if (this.failSets) throw new Error('QUOTA_BYTES quota exceeded');
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
  stored(): StoreData {
    const p = parseStore(this.data.get(STORE_KEY));
    if (p.status !== 'ok') throw new Error(p.status);
    return p.store;
  }
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

describe('restore through the service worker handler', () => {
  it('validates forged messages at the worker boundary and writes nothing', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    const s = richLedger();
    (s.cases[0] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = 1.5;
    const forged = [
      request('op-1', { revision: 0, stored: false, epoch: null }, envelope(s)),
      request('op 1'),
      request('op-1', { revision: -1, stored: false, epoch: null }),
      { ...request(), extra: true },
      request('op-1', { revision: 0, stored: false, epoch: null }, { ...envelope(), formatVersion: 9 }),
      { kind: 'restore', operationId: 'op-1', expected: { revision: 0, stored: false, epoch: null } },
    ];
    for (const msg of forged) {
      expect(await handler.handle(msg)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    }
    expect(area.setCalls).toBe(0);
    expect(area.data.has(STORE_KEY)).toBe(false);
    expect(parseRequest({ kind: 'restore' }).ok).toBe(false);
  });

  it('applies once; identical retries, restarts and later edits never duplicate or overwrite', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    expect(await handler.handle(request())).toEqual({ ok: true, outcome: 'applied', revision: 1 });
    const restored = area.stored();
    expect(JSON.parse(JSON.stringify(restored.cases))).toEqual(richLedger().cases);
    expect(restored.lastRestore?.operationId).toBe('op-1');
    expect(area.setCalls).toBe(1);

    // A later user entry, then the same operation retried by a fresh handler (service worker restart).
    await handler.handle({ kind: 'mutate', command: { type: 'recordEntry', caseId: 'real-2', entry: { id: 'later', kind: 'receipt', itemId: 'c', amountCents: 100, occurredOn: null, source: 'Manual', note: '', reference: null } } });
    const afterEdit = structuredClone(area.data.get(STORE_KEY));
    const restarted = createHandler(area, () => NOW);
    expect(await restarted.handle(request())).toEqual({ ok: true, outcome: 'duplicate', revision: 2 });
    expect(area.data.get(STORE_KEY)).toEqual(afterEdit);

    // Same id, different contents: conflict, nothing replaced.
    const other = richLedger();
    other.cases.pop();
    expect(await restarted.handle(request('op-1', { revision: 0, stored: false, epoch: null }, envelope(other)))).toMatchObject({ ok: false, error: { code: 'conflict' } });
    // A different operation is refused because the ledger is not empty.
    expect(await restarted.handle(request('op-2'))).toMatchObject({ ok: false, error: { code: 'restore_not_empty' } });
    expect(area.data.get(STORE_KEY)).toEqual(afterEdit);
    expect(area.setCalls).toBe(2);
  });

  it('a rejected write changes nothing and an identical retry can succeed', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    area.failSets = true;
    expect(await handler.handle(request())).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('nothing was restored') } });
    expect(area.data.has(STORE_KEY)).toBe(false);
    area.failSets = false;
    expect(await handler.handle(request())).toMatchObject({ ok: true, outcome: 'applied' });
  });

  it('never treats corrupt, unsupported or unreadable storage as empty', async () => {
    for (const raw of [{ schemaVersion: 1, revision: 'x', cases: [] }, { schemaVersion: 99, revision: 1, cases: [] }, 'garbage']) {
      const area = new FakeArea();
      area.data.set(STORE_KEY, raw);
      const res = await createHandler(area).handle(request('op-1', { revision: 0, stored: true, epoch: null }));
      expect(res.ok).toBe(false);
      expect(area.setCalls).toBe(0);
      expect(area.data.get(STORE_KEY)).toEqual(raw);
    }
    const area = new FakeArea();
    area.failGets = true;
    expect(await createHandler(area).handle(request())).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(area.setCalls).toBe(0);
  });

  it('serialises concurrent restores: exactly one complete ledger, never a mix', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    const other = { schemaVersion: 1, revision: 3, cases: [richLedger().cases[1]] };
    const [a, b] = await Promise.all([handler.handle(request('op-a')), handler.handle(request('op-b', { revision: 0, stored: false, epoch: null }, envelope(other)))]);
    expect(a).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
    expect(b).toMatchObject({ ok: false, error: { code: 'restore_not_empty' } });
    expect(JSON.parse(JSON.stringify(area.stored().cases))).toEqual(richLedger().cases);
    expect(area.setCalls).toBe(1);
  });

  it('an empty backup is a no-op that writes nothing', async () => {
    const area = new FakeArea();
    const res = await createHandler(area).handle(request('op-1', { revision: 0, stored: false, epoch: null }, envelope({ schemaVersion: 1, revision: 0, cases: [] })));
    expect(res).toEqual({ ok: true, outcome: 'unchanged', revision: 0 });
    expect(area.setCalls).toBe(0);
  });

  it('deleting restored cases or erasing data never lets an old retry resurrect them at the worker', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    await handler.handle(request('op-1', { revision: 0, stored: false, epoch: null }));
    for (const id of ['real-1', 'real-2']) await handler.handle({ kind: 'mutate', command: { type: 'deleteCase', caseId: id } });
    await handler.handle({ kind: 'mutate', command: { type: 'removeDemo' } });
    expect(area.stored().cases).toHaveLength(0);
    const emptied = structuredClone(area.data.get(STORE_KEY));
    // The receipt survives in the same record, so the retry is recognised, not re-applied.
    expect(await handler.handle(request('op-1'))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(area.data.get(STORE_KEY)).toEqual(emptied);

    // An approval made against a written ledger never matches the erased one.
    const approvedAt = area.stored().revision;
    expect(await handler.handle({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: true });
    expect(await handler.handle(request('op-2', { revision: approvedAt, stored: true, epoch: null }))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(area.stored()).toMatchObject({ revision: 0, cases: [] });
    expect(area.stored().lastRestore).toBeUndefined();
  });

  const ERASE = { kind: 'eraseAll', confirm: ERASE_CONFIRMATION };
  const FRESH = { revision: 0, stored: false, epoch: null };

  it('replaying a committed first restore verbatim after one or more erases never resurrects it (handler recreated)', async () => {
    const area = new FakeArea();
    let epochs = 0;
    const make = () => createHandler(area, () => NOW, () => `epoch-${++epochs}`);
    const original = request('op-first', FRESH);
    expect(await make().handle(original)).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(await make().handle(ERASE)).toMatchObject({ ok: true });
      const erased = structuredClone(area.data.get(STORE_KEY));
      // Same request, same id, same original token, sent to a new handler instance.
      expect(await make().handle(structuredClone(original))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
      expect(area.data.get(STORE_KEY)).toEqual(erased);
      expect(area.stored().cases).toEqual([]);
    }
    // A fresh read and a new approval (new id, current token) restore exactly once.
    const dest = area.stored();
    expect(dest.ledgerEpoch).toBe('epoch-3');
    const fresh = request('op-new', { revision: dest.revision, stored: true, epoch: dest.ledgerEpoch ?? null });
    expect(await make().handle(fresh)).toMatchObject({ ok: true, outcome: 'applied', revision: 1 });
    expect(await make().handle(fresh)).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(await make().handle(original)).toMatchObject({ ok: false });
    expect(area.stored().lastRestore?.operationId).toBe('op-new');
    expect(area.stored().ledgerEpoch).toBe('epoch-3');
  });

  it('a first restore delivered late, after another view created data and erased it, is refused', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW);
    const delayed = request('op-late', FRESH); // approved against the never-written profile
    await handler.handle({ kind: 'mutate', command: { type: 'loadDemo' } });
    await handler.handle(ERASE);
    await handler.handle({ kind: 'mutate', command: { type: 'loadDemo' } });
    await handler.handle({ kind: 'mutate', command: { type: 'removeDemo' } });
    await handler.handle(ERASE);
    const before = structuredClone(area.data.get(STORE_KEY));
    expect(await createHandler(area).handle(delayed)).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(area.data.get(STORE_KEY)).toEqual(before);
  });

  it('keeps the destination marker through mutations, deletion and restore; never imports a backup’s marker', async () => {
    const area = new FakeArea();
    const handler = createHandler(area, () => NOW, () => 'dest-epoch');
    await handler.handle(ERASE);
    await handler.handle({ kind: 'mutate', command: { type: 'loadDemo' } });
    await handler.handle({ kind: 'mutate', command: { type: 'removeDemo' } });
    expect(area.stored()).toMatchObject({ ledgerEpoch: 'dest-epoch', revision: 2 });
    const source = { ...richLedger(), ledgerEpoch: 'source-epoch' };
    expect(await handler.handle(request('op-1', { revision: 2, stored: true, epoch: 'source-epoch' }, envelope(source)))).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(await handler.handle(request('op-1', { revision: 2, stored: true, epoch: 'dest-epoch' }, envelope(source)))).toMatchObject({ ok: true, outcome: 'applied' });
    expect(area.stored().ledgerEpoch).toBe('dest-epoch');
    await handler.handle({ kind: 'mutate', command: { type: 'deleteCase', caseId: 'real-1' } });
    expect(area.stored().ledgerEpoch).toBe('dest-epoch');
    // Invalid markers are rejected on read and at the message boundary.
    expect(parseStore({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: 'bad epoch!' }).status).toBe('corrupt');
    expect(parseRequest(request('op-9', { revision: 0, stored: true, epoch: 5 } as never)).ok).toBe(false);
    expect(parseRequest(request('op-9', { revision: 0, stored: true } as never)).ok).toBe(false);
  });
});
