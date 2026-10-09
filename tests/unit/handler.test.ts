import { describe, expect, it } from 'vitest';
import { createHandler } from '../../src/background/handler';
import { ERASE_CONFIRMATION } from '../../src/background/messages';
import { STORE_KEY, loadStore, type StorageAreaLike } from '../../src/persistence/storage';

/** In-memory storage that clones like chrome.storage and can be told to fail. */
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

  it('reports a failed save and leaves stored data untouched (acceptance 10)', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create('c1'));
    const before = structuredClone(area.data.get(STORE_KEY));
    area.failSets = true;
    const res = await handler.handle(create('c2'));
    expect(res).toMatchObject({ ok: false, error: { code: 'save_failed' } });
    expect(area.data.get(STORE_KEY)).toEqual(before);
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
    expect(area.data.has(STORE_KEY)).toBe(false);
  });

  it('reports storage read errors without writing', async () => {
    const area = new FakeArea();
    area.failGets = true;
    const res = await createHandler(area).handle(create('c1'));
    expect(res).toMatchObject({ ok: false, error: { code: 'storage_error' } });
    expect(area.setCalls).toBe(0);
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
