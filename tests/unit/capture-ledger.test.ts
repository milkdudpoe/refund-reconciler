// Ledger and storage behaviour for captured merchant reports. All excerpts are
// SYNTHETIC test fixtures.

import { describe, expect, it } from 'vitest';
import { createHandler } from '../../src/background/handler';
import { analyzeExcerpt } from '../../src/capture/parse';
import { summarizeItem } from '../../src/domain/reconcile';
import type { CaptureProvenance, RecordEntryCommand } from '../../src/domain/types';
import { CAPTURE_SOURCE, parseCommand, parseStore } from '../../src/domain/validate';
import { STORE_KEY, loadStore, type StorageAreaLike } from '../../src/persistence/storage';
import { Harness } from './helpers';

function captured(id: string, itemId: string, text: string, over: Partial<CaptureProvenance> = {}): RecordEntryCommand['entry'] {
  const a = analyzeExcerpt(text);
  if (!a.issued) throw new Error(`fixture has no issued amount: ${a.problems.join(',')}`);
  return {
    id,
    kind: 'merchant_report',
    itemId,
    amountCents: a.issued.cents,
    occurredOn: a.date.status === 'found' ? a.date.value : null,
    source: CAPTURE_SOURCE,
    note: '',
    reference: null,
    capture: {
      sourceOrigin: 'https://www.amazon.com',
      sourcePath: '/gp/your-account/order-details',
      capturedAt: '2026-10-01T12:00:00.000Z',
      excerpt: a.excerpt,
      parserVersion: a.parserVersion,
      approvedAmountText: a.issued.amountText,
      detectedOrderRef: a.orderRef.status === 'found' ? a.orderRef.value : null,
      itemApplicabilityConfirmed: true,
      ...over,
    },
  };
}

const item = (h: Harness, caseId: string, itemId: string) => {
  const c = h.case(caseId);
  return summarizeItem(c, c.items.find((i) => i.id === itemId)!);
};

describe('captured merchant reports in the ledger', () => {
  it('$70 issued against $70 expected stays issued/unconfirmed and creates no receipt (acceptance 1, 4)', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    const before = h.store;
    const res = h.record('c', captured('cap-1', 'a', 'Refund issued: $70.00'));
    expect(res).toMatchObject({ ok: true, outcome: 'applied' });
    const s = item(h, 'c', 'a');
    expect(s.status).toBe('issued_unconfirmed');
    expect(s.merchantReportedCents).toBe(7000);
    expect(s.confirmedReceivedCents).toBe(0);
    expect(s.expectedCents).toBe(7000);
    expect(h.case('c').entries.filter((e) => e.kind === 'receipt' || e.kind === 'recharge')).toHaveLength(0);
    expect(h.case('c').entries).toHaveLength(before.cases[0]!.entries.length + 1);
  });

  it('$35 issued against $70 expected and $70 received needs review, net $70, difference $0; a void keeps provenance (acceptance 6)', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 7000 });
    expect(h.record('c', captured('cap-1', 'a', 'Refund issued: $35.00')).ok).toBe(true);
    let s = item(h, 'c', 'a');
    expect(s.reviewReasons).toEqual(['merchant_reports_less_than_confirmed']);
    expect(s.netConfirmedCents).toBe(7000);
    expect(s.differenceCents).toBe(0);

    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v', targetEntryId: 'cap-1', reason: 'Selected the wrong item' });
    s = item(h, 'c', 'a');
    expect(s.reviewReasons).toEqual([]);
    const original = h.case('c').entries.find((e) => e.id === 'cap-1');
    expect(original).toMatchObject({ kind: 'merchant_report', capture: { excerpt: 'Refund issued: $35.00', approvedAmountText: '$35.00' } });
  });

  it('retries are idempotent; conflicting reuse of a capture id never overwrites (acceptance 5)', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    const entry = captured('cap-1', 'a', 'Refund issued: $70.00');
    expect(h.record('c', entry)).toMatchObject({ ok: true, outcome: 'applied' });
    expect(h.record('c', entry)).toMatchObject({ ok: true, outcome: 'duplicate' });
    const stored = h.store;
    for (const conflicting of [
      captured('cap-1', 'a', 'Refund issued: $35.00'),
      captured('cap-1', 'a', 'Refunded: $70.00'),
      captured('cap-1', 'a', 'Refund issued: $70.00', { capturedAt: '2026-10-02T00:00:00.000Z' }),
      captured('cap-1', 'a', 'Refund issued: $70.00', { sourceOrigin: 'https://amazon.com' }),
      { ...entry, capture: undefined },
    ]) {
      const { capture, ...rest } = conflicting;
      const res = h.record('c', capture ? conflicting : rest);
      expect(res).toMatchObject({ ok: false, error: { code: 'conflict' } });
    }
    expect(h.store).toBe(stored);
    expect(h.case('c').entries.filter((e) => e.kind === 'merchant_report')).toHaveLength(1);
  });

  it('a genuinely later capture of the same text is a new dated snapshot, not suppressed and not summed', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    h.record('c', captured('cap-1', 'a', 'Refund issued: $35.00'));
    expect(h.record('c', captured('cap-2', 'a', 'Refund issued: $35.00', { capturedAt: '2026-10-05T00:00:00.000Z' }))).toMatchObject({ ok: true, outcome: 'applied' });
    expect(h.case('c').entries.filter((e) => e.kind === 'merchant_report')).toHaveLength(2);
    expect(item(h, 'c', 'a').merchantReportedCents).toBe(3500);
  });

  it('equal amounts on two cases or items stay separate (acceptance 4)', () => {
    const h = new Harness();
    h.createCase('c1', [{ id: 'a', expected: 3500 }, { id: 'b', expected: 3500 }]);
    h.createCase('c2', [{ id: 'z', expected: 3500 }]);
    h.record('c1', captured('cap-1', 'a', 'Refund issued: $35.00'));
    expect(item(h, 'c1', 'a').merchantReportedCents).toBe(3500);
    expect(item(h, 'c1', 'b').merchantReportedCents).toBeNull();
    expect(item(h, 'c2', 'z').merchantReportedCents).toBeNull();
  });

  it('refuses demo cases, a different known order, and excerpts that do not support the amount (acceptance 4)', () => {
    const h = new Harness();
    h.must({ type: 'loadDemo' });
    expect(h.record('demo-case-partial', captured('cap-d', 'demo-item-b', 'Refund issued: $35.00'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('synthetic demo') } });

    h.createCase('c', [{ id: 'a', expected: 7000 }], '112-1234567-7654321');
    expect(h.record('c', captured('cap-o', 'a', 'Order 113-1234567-7654321\nRefund issued: $70.00'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('different order') } });
    expect(h.record('c', captured('cap-m', 'a', 'Order 112-1234567-7654321\nRefund issued: $70.00')).ok).toBe(true);

    const tampered = captured('cap-t', 'a', 'Refund issued: $70.00');
    expect(h.record('c', { ...tampered, amountCents: 8000, capture: { ...tampered.capture!, approvedAmountText: '$80.00', excerpt: 'Item price: $80.00 Refund issued: $70.00' } }).ok).toBe(false);
    expect(h.record('c', { ...tampered, capture: { ...tampered.capture!, excerpt: 'Refund pending: $70.00' } }).ok).toBe(false);
    expect(h.record('c', { ...tampered, occurredOn: '2026-01-01' }).ok).toBe(false);
    expect(h.record('c', { ...tampered, capture: { ...tampered.capture!, parserVersion: 'other-0' } }).ok).toBe(false);
    expect(h.case('c').entries.filter((e) => e.kind === 'merchant_report')).toHaveLength(1);
  });
});

describe('provenance validation', () => {
  const base = () => captured('cap-1', 'a', 'Order 112-1234567-7654321\nRefund issued on Oct 3, 2026: $70.00');

  it('accepts a well-formed captured command and keeps manual commands unchanged', () => {
    expect(parseCommand({ type: 'recordEntry', caseId: 'c', entry: base() })).toMatchObject({ ok: true });
    const manual: Record<string, unknown> = { ...base() };
    delete manual.capture;
    expect(parseCommand({ type: 'recordEntry', caseId: 'c', entry: { ...manual, source: 'Manual' } })).toMatchObject({ ok: true });
  });

  it.each<[string, (e: any) => void]>([
    ['extra field', (e) => { e.capture.html = '<div>'; }],
    ['missing field', (e) => { delete e.capture.detectedOrderRef; }],
    ['lookalike origin', (e) => { e.capture.sourceOrigin = 'https://www.amazon.com.evil.example'; }],
    ['tracking query kept', (e) => { e.capture.sourcePath = '/gp/x?session-id=1'; }],
    ['fragment kept', (e) => { e.capture.sourcePath = '/gp/x#y'; }],
    ['over-long excerpt', (e) => { e.capture.excerpt = 'x'.repeat(4001); }],
    ['amount text not in excerpt', (e) => { e.capture.approvedAmountText = '$71.00'; e.amountCents = 7100; }],
    ['amount text differs from amount', (e) => { e.amountCents = 3500; }],
    ['not confirmed for item', (e) => { e.capture.itemApplicabilityConfirmed = false; }],
    ['receipt with capture', (e) => { e.kind = 'receipt'; }],
    ['wrong source label', (e) => { e.source = 'Manual entry'; }],
    ['reference on capture', (e) => { e.reference = 'R1'; }],
  ])('rejects %s', (_n, mutate) => {
    const e = JSON.parse(JSON.stringify(base()));
    mutate(e);
    expect(parseCommand({ type: 'recordEntry', caseId: 'c', entry: e }).ok).toBe(false);
  });

  it('stored captured entries round-trip; stored provenance is validated too', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }], '112-1234567-7654321');
    h.must({ type: 'recordEntry', caseId: 'c', entry: base() });
    const raw = JSON.parse(JSON.stringify(h.store));
    expect(parseStore(raw)).toEqual({ status: 'ok', store: h.store });
    raw.cases[0].entries[1].capture.sourceOrigin = 'https://evil.example';
    expect(parseStore(raw).status).toBe('corrupt');
  });

  it('existing schema-1 data without provenance stays readable and writable (acceptance 7)', () => {
    // A literal Task 01 store: no `capture` field anywhere.
    const legacy = {
      schemaVersion: 1,
      revision: 3,
      cases: [
        {
          id: 'old', retailer: 'amazon_us', orderRef: '111-2223334-5556667', currency: 'USD', isDemo: false,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
          items: [{ id: 'i', label: 'Old kettle', createdAt: '2026-01-01T00:00:00.000Z' }],
          entries: [
            { id: 'e', kind: 'expectation', itemId: 'i', amountCents: 7000, recordedAt: '2026-01-01T00:00:00.000Z', occurredOn: null, source: 'Manual entry', note: 'Initial expected refund' },
            { id: 'm', kind: 'merchant_report', itemId: 'i', amountCents: 7000, recordedAt: '2026-01-01T00:00:01.000Z', occurredOn: null, source: 'Merchant order page (entered manually)', note: '', reference: null },
            { id: 'v', kind: 'void', itemId: 'i', targetEntryId: 'm', recordedAt: '2026-01-02T00:00:00.000Z', occurredOn: null, source: 'Manual entry', note: 'Typo' },
          ],
        },
      ],
    };
    const parsed = parseStore(structuredClone(legacy));
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.store).toEqual(legacy);
    const h = new Harness();
    h.store = parsed.store;
    expect(h.record('old', captured('cap-1', 'i', 'Order 111-2223334-5556667\nRefund issued: $70.00')).ok).toBe(true);
    expect(h.case('old').entries.slice(0, 3)).toEqual(legacy.cases[0]!.entries);
  });
});

class FakeArea implements StorageAreaLike {
  data = new Map<string, unknown>();
  failSets = false;
  setCalls = 0;
  async get(key: string) {
    return this.data.has(key) ? { [key]: structuredClone(this.data.get(key)) } : {};
  }
  async set(items: Record<string, unknown>) {
    this.setCalls += 1;
    if (this.failSets) throw new Error('QUOTA_BYTES quota exceeded');
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

describe('captured reports through the service-worker handler (acceptance 5)', () => {
  const create = { kind: 'mutate', command: { type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'Kettle', expectedCents: 7000, expectationEntryId: 'e' }] } };
  const save = { kind: 'mutate', command: { type: 'recordEntry', caseId: 'c', entry: captured('cap-1', 'a', 'Refund issued: $70.00') } };
  const reports = async (area: FakeArea) => {
    const loaded = await loadStore(area);
    if (loaded.status !== 'ok') throw new Error(loaded.status);
    return loaded.store.cases[0]!.entries.filter((e) => e.kind === 'merchant_report');
  };

  it('a rejected write saves nothing and a retry with the same capture id saves once', async () => {
    const area = new FakeArea();
    const handler = createHandler(area);
    await handler.handle(create);
    const before = structuredClone(area.data.get(STORE_KEY));
    area.failSets = true;
    expect(await handler.handle(save)).toMatchObject({ ok: false, error: { code: 'write_rejected' } });
    expect(area.data.get(STORE_KEY)).toEqual(before);
    area.failSets = false;
    const results = await Promise.all([handler.handle(save), handler.handle(save), handler.handle(save)]);
    expect(results.map((r) => r.ok && r.outcome)).toEqual(['applied', 'duplicate', 'duplicate']);
    const stored = await reports(area);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'cap-1', capture: { approvedAmountText: '$70.00' } });
  });
});
