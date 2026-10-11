// Ledger and storage behaviour for captured merchant reports. All excerpts are
// SYNTHETIC test fixtures.

import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, analyzeExcerpt } from '../../src/capture/parse';
import { summarizeItem } from '../../src/domain/reconcile';
import type { CaptureProvenance, RecordEntryCommand } from '../../src/domain/types';
import { CAPTURE_SOURCE, parseCommand, parseStore } from '../../src/domain/validate';
import { VAULT_KEY } from '../../src/persistence/storage';
import { makeWorld, setUp, storedStore, type World } from './vault-fakes';
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

const vaultWrites = (w: World) => w.log.filter((o) => o.type === 'set' && o.keys.includes(VAULT_KEY)).length;

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

describe('malformed amount tokens cannot reach storage (finding 1)', () => {
  // Hand-built commands claiming the valid-looking prefix the old parser salvaged.
  const forged = (excerpt: string, amountText: string, cents: number, parserVersion = PARSER_VERSION): RecordEntryCommand['entry'] => ({
    id: 'cap-forged',
    kind: 'merchant_report',
    itemId: 'a',
    amountCents: cents,
    occurredOn: null,
    source: CAPTURE_SOURCE,
    note: '',
    reference: null,
    capture: {
      sourceOrigin: 'https://www.amazon.com',
      sourcePath: '/gp/your-account/order-details',
      capturedAt: '2026-10-01T12:00:00.000Z',
      excerpt,
      parserVersion,
      approvedAmountText: amountText,
      detectedOrderRef: null,
      itemApplicabilityConfirmed: true,
    },
  });

  it.each([
    ['Refund issued: $1e3', '$1', 100],
    ['Refund issued: $70 000.00', '$70', 7000],
    ['Refund issued: $70/00', '$70', 7000],
  ])('%j is refused at the runtime/ledger boundary', async (excerpt, amountText, cents) => {
    expect(analyzeExcerpt(excerpt).issued).toBeNull();
    const command = { type: 'recordEntry', caseId: 'c', entry: forged(excerpt, amountText, cents) };
    // Structurally valid, so the ledger's parser recheck is what refuses it.
    const parsed = parseCommand(JSON.parse(JSON.stringify(command)));
    expect(parsed.ok).toBe(true);
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    expect(h.record('c', forged(excerpt, amountText, cents))).toMatchObject({ ok: false, error: { code: 'invalid' } });
    // An old parser version cannot be used to slip it through either.
    expect(h.record('c', forged(excerpt, amountText, cents, 'amazon-us-selection-1'))).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.case('c').entries.filter((e) => e.kind === 'merchant_report')).toHaveLength(0);

    const w = await makeWorld();
    await setUp(w);
    await w.send({ kind: 'mutate', command: { type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'K', expectedCents: 7000, expectationEntryId: 'e' }] } });
    expect(await w.send({ kind: 'mutate', command })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    const stored = await storedStore(w);
    expect(stored.cases[0].entries.filter((e: { kind: string }) => e.kind === 'merchant_report')).toHaveLength(0);
  });

  it('an already stored capture from the previous parser version stays readable and is never recomputed', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    const raw = JSON.parse(JSON.stringify(h.store));
    const old = forged('Refund issued: $1e3', '$1', 100, 'amazon-us-selection-1');
    raw.cases[0].entries.push({ ...old, recordedAt: '2026-10-01T12:00:01.000Z' });
    const parsed = parseStore(raw);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    const stored = parsed.store.cases[0]!.entries[1]!;
    expect(stored).toMatchObject({ amountCents: 100, capture: { parserVersion: 'amazon-us-selection-1', approvedAmountText: '$1' } });
    h.store = parsed.store;
    expect(item(h, 'c', 'a').merchantReportedCents).toBe(100);
    // An identical retry of that stored operation is still a harmless duplicate.
    expect(h.record('c', old)).toMatchObject({ ok: true, outcome: 'duplicate' });
  });
});

describe('source-page order context at the write boundary (finding 2)', () => {
  const A = '112-1234567-7654321';
  const B = '113-7654321-1234567';
  const withPath = (text: string, sourcePath: string | null, id = 'cap-1') => captured(id, 'a', text, { sourcePath });

  it('refuses a URL-only order that differs from the case, accepts a matching or unknown one', () => {
    const h = new Harness();
    h.createCase('caseB', [{ id: 'a', expected: 7000 }], B);
    expect(h.record('caseB', withPath('Refund issued: $70.00', `/gp/your-account/order-details?orderID=${A}`))).toMatchObject({ ok: false, error: { message: expect.stringContaining('different order') } });
    expect(h.record('caseB', withPath('Refund issued: $70.00', `/your-orders/${A}/details`))).toMatchObject({ ok: false });
    expect(h.record('caseB', withPath('Refund issued: $70.00', `/gp/your-account/order-details?orderID=${B}`, 'cap-2')).ok).toBe(true);
    expect(h.record('caseB', withPath('Refund issued: $70.00', '/gp/your-account/order-details', 'cap-3')).ok).toBe(true);
    expect(h.record('caseB', withPath('Refund issued: $70.00', null, 'cap-4')).ok).toBe(true);
    expect(h.case('caseB').entries.filter((e) => e.kind === 'merchant_report').map((e) => e.id)).toEqual(['cap-2', 'cap-3', 'cap-4']);
  });

  it('refuses a URL order that contradicts the order in the selected text, whatever the case', () => {
    const h = new Harness();
    h.createCase('caseA', [{ id: 'a', expected: 7000 }], A);
    h.createCase('none', [{ id: 'a2', expected: 7000 }]);
    expect(h.record('caseA', withPath(`Order ${A}\nRefund issued: $70.00`, `/gp/x?orderID=${B}`))).toMatchObject({ ok: false, error: { message: expect.stringContaining('conflicting orders') } });
    expect(h.record('none', { ...captured('cap-n', 'a2', `Order ${A}\nRefund issued: $70.00`), capture: { ...captured('cap-n', 'a2', `Order ${A}\nRefund issued: $70.00`).capture!, sourcePath: `/gp/x?orderID=${B}` } })).toMatchObject({ ok: false });
    expect(h.record('caseA', withPath(`Order ${A}\nRefund issued: $70.00`, `/gp/x?orderID=${A}`, 'cap-ok')).ok).toBe(true);
  });

  it('existing captures and manual data are unaffected', () => {
    const h = new Harness();
    h.createCase('caseB', [{ id: 'a', expected: 7000 }], B);
    h.record('caseB', { id: 'm', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });
    const raw = JSON.parse(JSON.stringify(h.store));
    // A capture stored before this rule existed, whose path names another order, still reads as written.
    raw.cases[0].entries.push({ ...withPath('Refund issued: $70.00', `/gp/x?orderID=${A}`, 'cap-old'), recordedAt: '2026-10-01T12:00:01.000Z' });
    expect(parseStore(raw).status).toBe('ok');
  });

  it('a direct service-worker command with a URL-only mismatch is rejected and nothing is written', async () => {
    const w = await makeWorld();
    await setUp(w);
    await w.send({ kind: 'mutate', command: { type: 'createCase', caseId: 'caseB', orderRef: B, items: [{ itemId: 'a', label: 'K', expectedCents: 7000, expectationEntryId: 'e' }] } });
    const writes = vaultWrites(w);
    const res = await w.send({ kind: 'mutate', command: { type: 'recordEntry', caseId: 'caseB', entry: withPath('Refund issued: $70.00', `/gp/your-account/order-details?orderID=${A}`) } });
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(vaultWrites(w)).toBe(writes);
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

describe('captured reports through the service-worker handler (acceptance 5)', () => {
  const create = { kind: 'mutate', command: { type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'Kettle', expectedCents: 7000, expectationEntryId: 'e' }] } };
  const save = { kind: 'mutate', command: { type: 'recordEntry', caseId: 'c', entry: captured('cap-1', 'a', 'Refund issued: $70.00') } };
  const reports = async (w: World) => (await storedStore(w)).cases[0].entries.filter((e: { kind: string }) => e.kind === 'merchant_report');

  it('a rejected write saves nothing and a retry with the same capture id saves once', async () => {
    const w = await makeWorld();
    await setUp(w);
    await w.send(create);
    const before = structuredClone(w.local.data.get(VAULT_KEY));
    w.local.fault = (o) => (o.type === 'set' ? 'reject' : undefined);
    expect(await w.send(save)).toMatchObject({ ok: false, error: { code: 'write_rejected' } });
    expect(w.local.data.get(VAULT_KEY)).toEqual(before);
    w.local.fault = null;
    const results = await Promise.all([w.send(save), w.send(save), w.send(save)]);
    expect(results.map((r) => r.ok && r.outcome)).toEqual(['applied', 'duplicate', 'duplicate']);
    const stored = await reports(w);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'cap-1', capture: { approvedAmountText: '$70.00' } });
  });
});
