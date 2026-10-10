import { describe, expect, it } from 'vitest';
import { createHandler } from '../../src/background/handler';
import { ERASE_CONFIRMATION } from '../../src/background/messages';
import { STORE_KEY, loadStore, type StorageAreaLike } from '../../src/persistence/storage';

/** In-memory storage that clones like chrome.storage and can be told to fail. */
class FakeArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  failSets = false;
  failGets = false;
  /** When set, the next successful write breaks all later reads (e.g. a confirmation read). */
  failReadsAfterNextWrite = false;
  readsBroken = false;
  setCalls = 0;
  getCalls = 0;

  async get(key: string) {
    this.getCalls += 1;
    await Promise.resolve();
    if (this.failGets || this.readsBroken) throw new Error('confirmation read failed');
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
  }
  async set(items: Record<string, unknown>) {
    this.setCalls += 1;
    await new Promise((r) => setTimeout(r, 1));
    if (this.failSets) throw new Error('QUOTA_BYTES quota exceeded');
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
    if (this.failReadsAfterNextWrite) {
      this.failReadsAfterNextWrite = false;
      this.readsBroken = true;
    }
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

const create = (caseId: string, expectedCents = 3500) => ({
  kind: 'mutate',
  command: { type: 'createCase', caseId, orderRef: null, items: [{ itemId: `${caseId}-a`, label: 'Item', expectedCents, expectationEntryId: `${caseId}-e` }] },
});
const receipt = (caseId: string, id: string, amountCents = 3500) => ({
  kind: 'mutate',
  command: { type: 'recordEntry', caseId, entry: { id, kind: 'receipt', itemId: `${caseId}-a`, amountCents, occurredOn: null, source: 'Manual', note: '', reference: null } },
});

async function storedCases(area: FakeArea) {
  const loaded = await loadStore(area);
  if (loaded.status !== 'ok') throw new Error(loaded.status);
  return loaded.store.cases;
}

describe('service worker handler', () => {
  it('starts empty, persists, and reports success only after the write', async () => {
    const area = new FakeArea();
    expect(await loadStore(area)).toMatchObject({ status: 'ok', isNew: true });
    const handler = createHandler(area);
    const res = await handler.handle(create('c1'));
    expect(res).toEqual({ ok: true, outcome: 'applied', revision: 1 });
    expect(await storedCases(area)).toHaveLength(1);
  });

  it('a rejected write is reported as not saved and leaves the old state intact (acceptance 10)', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create('c1', 7000));
    const before = structuredClone(area.data.get(STORE_KEY));
    area.failSets = true;
    const res = await handler.handle(receipt('c1', 'r1', 7000));
    expect(res).toMatchObject({ ok: false, error: { code: 'write_rejected', message: expect.stringContaining('not saved') } });
    expect(area.data.get(STORE_KEY)).toEqual(before);

    // Retrying the same operation once storage accepts writes records it exactly once.
    area.failSets = false;
    expect(await handler.handle(receipt('c1', 'r1', 7000))).toMatchObject({ ok: true, outcome: 'applied' });
    const cases = await storedCases(area);
    expect(cases[0]?.entries.filter((e) => e.kind === 'receipt')).toHaveLength(1);
  });

  it('a committed write is reported as saved even if storage cannot be read afterwards (review finding 2)', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create('c1', 7000));
    const revisionBefore = (area.data.get(STORE_KEY) as { revision: number }).revision;

    area.failReadsAfterNextWrite = true;
    const getsBefore = area.getCalls;
    const res = await handler.handle(receipt('c1', 'stable-id', 7000));
    // set() resolved, so the write is committed and must not be reported as "Not saved".
    expect(res).toEqual({ ok: true, outcome: 'applied', revision: revisionBefore + 1 });
    // The handler reads once (to apply the command) and never re-reads after writing.
    expect(area.getCalls - getsBefore).toBe(1);

    // Recovery: once reads work again, exactly one receipt and the incremented revision are visible.
    expect(area.readsBroken).toBe(true);
    area.readsBroken = false;
    const loaded = await loadStore(area);
    if (loaded.status !== 'ok') throw new Error(loaded.status);
    expect(loaded.store.revision).toBe(revisionBefore + 1);
    expect(loaded.store.cases[0]?.entries.filter((e) => e.kind === 'receipt').map((e) => e.id)).toEqual(['stable-id']);

    // A retry with the same id (what the dashboard sends) is a duplicate: no second write, no second receipt.
    const writes = area.setCalls;
    expect(await handler.handle(receipt('c1', 'stable-id', 7000))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(area.setCalls).toBe(writes);
    const after = await storedCases(area);
    expect(after[0]?.entries.filter((e) => e.kind === 'receipt')).toHaveLength(1);
  });

  it('a read failure before writing reports that no change was attempted', async () => {
    const area = new FakeArea();
    area.failGets = true;
    const res = await createHandler(area).handle(create('c1'));
    expect(res).toMatchObject({ ok: false, error: { code: 'storage_error', message: expect.stringContaining('no change was attempted') } });
    expect(area.setCalls).toBe(0);
  });

  it('refuses to write over unsupported or unreadable data (acceptance 10)', async () => {
    for (const raw of [{ schemaVersion: 99, revision: 3, cases: [{ anything: true }] }, { schemaVersion: 1, revision: 'x', cases: 7 }, 'garbage']) {
      const area = new FakeArea();
      area.data.set(STORE_KEY, raw);
      const handler = createHandler(area);
      const res = await handler.handle(create('c1'));
      expect(res.ok).toBe(false);
      expect(area.setCalls).toBe(0);
      expect(area.data.get(STORE_KEY)).toEqual(raw);
    }
  });

  it('only erases unreadable data on an explicit confirmed request', async () => {
    const area = new FakeArea();
    area.data.set(STORE_KEY, { schemaVersion: 99 });
    const handler = createHandler(area);
    expect((await handler.handle({ kind: 'eraseAll', confirm: 'please' })).ok).toBe(false);
    expect(area.data.has(STORE_KEY)).toBe(true);
    expect((await handler.handle({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).ok).toBe(true);
    // Erase keeps no data at all: only an empty ledger with a fresh, opaque marker.
    const erased = area.data.get(STORE_KEY) as Record<string, unknown>;
    expect(Object.keys(erased).sort()).toEqual(['cases', 'ledgerEpoch', 'revision', 'schemaVersion']);
    expect(erased).toMatchObject({ schemaVersion: 1, revision: 0, cases: [] });
    expect(erased.ledgerEpoch).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(await loadStore(area)).toMatchObject({ status: 'ok', isNew: false, store: { cases: [] } });
  });

  it('erases corrupt data without reading it, and a rejected erase leaves the original data intact', async () => {
    const area = new FakeArea();
    const corrupt = { schemaVersion: 1, revision: 'NaN', cases: [{ id: 'secret', note: 'PRIVATE' }], lastRestore: 'junk', ledgerEpoch: 7 };
    area.data.set(STORE_KEY, corrupt);
    area.failGets = true; // erase must not depend on a successful read
    area.failSets = true;
    const handler = createHandler(area);
    expect(await handler.handle({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).toMatchObject({ ok: false, error: { code: 'write_rejected' } });
    expect(area.data.get(STORE_KEY)).toEqual(corrupt);
    area.failSets = false;
    expect((await handler.handle({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION })).ok).toBe(true);
    area.failGets = false;
    expect(JSON.stringify(area.data.get(STORE_KEY))).not.toMatch(/secret|PRIVATE|junk/);
    expect(await loadStore(area)).toMatchObject({ status: 'ok', store: { revision: 0, cases: [] } });
  });

  it('serialises concurrent writes from multiple views so none are lost', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create('c1', 10_000));
    const results = await Promise.all([
      handler.handle(receipt('c1', 'r1', 1000)),
      handler.handle(receipt('c1', 'r2', 2000)),
      handler.handle(create('c2')),
      handler.handle(receipt('c1', 'r3', 3000)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const cases = await storedCases(area);
    expect(cases.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(cases[0]?.entries.filter((e) => e.kind === 'receipt').map((e) => e.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('a duplicate submission does not write again', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create('c1'));
    await handler.handle(receipt('c1', 'r1'));
    const writes = area.setCalls;
    expect(await handler.handle(receipt('c1', 'r1'))).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(area.setCalls).toBe(writes);
  });

  it('rejects invalid messages before touching storage', async () => {
    const area = new FakeArea();
    const res = await createHandler(area).handle(receipt('c1', 'r1', -5));
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(area.setCalls).toBe(0);
  });
});
