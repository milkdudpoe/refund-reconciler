import { describe, expect, it } from 'vitest';
import { buildCaseSummaryText, formatUtc, oneLine } from '../../src/export/summary';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, buildBackup, countBackup, exportFilename, serializeBackup } from '../../src/export/backup';
import { applyCommand } from '../../src/domain/ledger';
import { CAPTURE_SOURCE, parseStore } from '../../src/domain/validate';
import { emptyStore, SCHEMA_VERSION, type RecordEntryCommand } from '../../src/domain/types';
import { analyzeExcerpt } from '../../src/capture/parse';
import { Harness } from './helpers';

function mustRecord(h: Harness, caseId: string, entry: RecordEntryCommand['entry']): void {
  const r = h.record(caseId, entry);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
}

const AT = '2026-10-10T12:00:00.000Z';
const summary = (h: Harness, caseId: string, includeDetails = false) =>
  buildCaseSummaryText(h.case(caseId), { generatedAt: AT, revision: h.store.revision, includeDetails });

/** The block of summary text for one item, from its heading to the next blank line. */
function itemBlock(text: string, label: string): string {
  const start = text.indexOf(`: ${label}\n`);
  if (start < 0) throw new Error(`no item ${label}`);
  return text.slice(start, text.indexOf('\n\n', start));
}

function captured(id: string, itemId: string, excerpt: string, parserVersion?: string): RecordEntryCommand['entry'] {
  const a = analyzeExcerpt(excerpt);
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
      capturedAt: '2026-10-01T09:30:00.000Z',
      excerpt: a.excerpt,
      parserVersion: parserVersion ?? a.parserVersion,
      approvedAmountText: a.issued.amountText,
      detectedOrderRef: a.orderRef.status === 'found' ? a.orderRef.value : null,
      itemApplicabilityConfirmed: true,
    },
  };
}

describe('case summary text', () => {
  it('acceptance 1: B keeps its $35 unresolved expectation; an excess on A never settles B', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Kettle A', expected: 3500 }, { id: 'b', label: 'Mug B', expected: 3500 }], '111-2223334-5556667');
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    let text = summary(h, 'c');
    expect(text).toContain('Retailer: Amazon US');
    expect(text).toContain('Order reference: 111-2223334-5556667');
    expect(text).toContain('Generated: 2026-10-10 12:00:00 UTC');
    expect(itemBlock(text, 'Mug B')).toContain('Unresolved expected amount: $35.00 (a difference in these records, not a proven amount owed)');
    expect(itemBlock(text, 'Mug B')).toContain('does not establish that no money arrived');
    expect(itemBlock(text, 'Kettle A')).toContain('Difference: $0.00');
    expect(text).toContain('Unresolved expected amount (sum of per-item shortfalls with a known expectation): $35.00');

    // A extra $35 on A is an excess on A, never an offset for B.
    h.record('c', { id: 'r2', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    text = summary(h, 'c');
    expect(itemBlock(text, 'Kettle A')).toContain('Excess over expected: $35.00');
    expect(itemBlock(text, 'Kettle A')).toContain('does not settle any other item');
    expect(itemBlock(text, 'Mug B')).toContain('Unresolved expected amount: $35.00');
    expect(text).toContain('Status in these records: Needs review');
    expect(text).not.toContain('Status in these records: Settled');
  });

  it('acceptance 2: a $70 merchant snapshot without a receipt stays issued/unconfirmed; snapshots are never added', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Headphones', expected: 7000 }]);
    h.record('c', { id: 'm1', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });
    h.record('c', { id: 'm2', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });
    const block = itemBlock(summary(h, 'c'), 'Headphones');
    expect(block).toContain('Status: Merchant reports issued; receipt not confirmed');
    expect(block).toContain('Latest active merchant-issued snapshot: $70.00 (merchant statement, not a receipt confirmation)');
    expect(block).toContain('Receipts confirmed by user: $0.00');
    expect(block).toContain('Unresolved expected amount: $70.00');
    expect(block).toContain('A merchant statement is not a receipt confirmation.');
    expect(block).toContain('2 merchant reports are recorded for this item. They are status snapshots and are not added together');
    expect(block).not.toContain('$140.00');
  });

  it('acceptance 3: a recharge shows $50 net and a $20 difference; voiding it keeps marked history and restores the state', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Jacket', expected: 7000 }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 7000 });
    h.record('c', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 2000 });
    let text = summary(h, 'c');
    expect(itemBlock(text, 'Jacket')).toContain('Confirmed net received: $50.00');
    expect(itemBlock(text, 'Jacket')).toContain('Unresolved expected amount: $20.00');
    expect(itemBlock(text, 'Jacket')).toContain('A recharge was recorded');

    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v1', targetEntryId: 'x1', reason: 'Different order' });
    text = summary(h, 'c');
    expect(itemBlock(text, 'Jacket')).toContain('Confirmed net received: $70.00');
    expect(itemBlock(text, 'Jacket')).toContain('Recharges recorded: $0.00');
    expect(itemBlock(text, 'Jacket')).toContain('Review conditions: none');
    expect(text).toContain('3. Recharge [VOIDED by entry 4 — kept as history, excluded from current totals]');
    expect(text).toContain('User recorded a $20.00 recharge');
    expect(text).toContain('Voided entry 3 (recharge of $20.00)');
    expect(text).toContain('Status in these records: Settled');
  });

  it('acceptance 4: a contradictory $35 snapshot keeps the review condition at zero difference; unknowns stay unknown', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Coat', expected: 7000 }, { id: 'b', label: 'Lamp', expected: null }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 7000 });
    h.record('c', { id: 'm1', kind: 'merchant_report', itemId: 'a', amountCents: 3500 });
    h.record('c', { id: 'r2', kind: 'receipt', itemId: 'b', amountCents: 500, occurredOn: '2026-03-01' });
    const text = summary(h, 'c');
    const coat = itemBlock(text, 'Coat');
    expect(coat).toContain('Difference: $0.00');
    expect(coat).toContain('— needs review');
    expect(coat).toContain('lower than the amount confirmed received');
    expect(coat).toContain('the zero difference does not resolve it');
    const lamp = itemBlock(text, 'Lamp');
    expect(lamp).toContain('Current expected refund: Unknown');
    expect(lamp).toContain('Difference: Unknown — the expected refund is unknown, so the difference cannot be calculated.');
    expect(lamp).toContain('there is no expected amount to compare them with');
    expect(text).toContain('Status in these records: Needs review');
    expect(text).toContain('Occurred: not given');
    expect(text).toContain('Occurred: 2026-03-01');
    expect(text).toContain('Expected refund set to Unknown');
  });

  it('keeps recording order even when occurrence dates are out of order or missing', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Desk', expected: 9000 }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 1000, occurredOn: '2026-05-01' });
    h.record('c', { id: 'r2', kind: 'receipt', itemId: 'a', amountCents: 2000, occurredOn: '2026-01-01' });
    h.record('c', { id: 'r3', kind: 'receipt', itemId: 'a', amountCents: 3000 });
    const text = summary(h, 'c');
    const i10 = text.indexOf('User confirmed $10.00');
    const i20 = text.indexOf('User confirmed $20.00');
    const i30 = text.indexOf('User confirmed $30.00');
    expect(i10).toBeGreaterThan(0);
    expect(i10).toBeLessThan(i20);
    expect(i20).toBeLessThan(i30);
  });

  it('expected-amount changes remain readable history', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Rug', expected: null }]);
    h.record('c', { id: 'e2', kind: 'expectation', itemId: 'a', amountCents: 2499 });
    h.record('c', { id: 'e3', kind: 'expectation', itemId: 'a', amountCents: 2000 });
    const text = summary(h, 'c');
    expect(text).toContain('Expected refund changed from Unknown to $24.99');
    expect(text).toContain('Expected refund changed from $24.99 to $20.00');
    expect(itemBlock(text, 'Rug')).toContain('Current expected refund: $20.00');
  });

  it('marks synthetic demo cases clearly', () => {
    const r = applyCommand(emptyStore(), { type: 'loadDemo' }, AT);
    if (!r.ok) throw new Error('demo');
    const demo = r.store.cases[0]!;
    const text = buildCaseSummaryText(demo, { generatedAt: AT, revision: r.store.revision, includeDetails: false });
    expect(text).toContain('SYNTHETIC DEMO DATA');
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 100 }]);
    expect(summary(h, 'c')).not.toContain('SYNTHETIC DEMO DATA');
  });

  it('attributes captured merchant statements, including a historical parser version', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Speaker', expected: 7000 }]);
    mustRecord(h, 'c', captured('cap-1', 'a', 'Order # 112-1234567-7654321\nRefund issued: $70.00'));
    const raw = JSON.parse(JSON.stringify(h.store));
    raw.cases[0].entries.push({ ...captured('cap-old', 'a', 'Refund issued: $35.00', 'amazon-us-selection-1'), recordedAt: '2026-10-02T00:00:00.000Z' });
    const parsed = parseStore(raw);
    if (parsed.status !== 'ok') throw new Error(parsed.status);
    const text = buildCaseSummaryText(parsed.store.cases[0]!, { generatedAt: AT, revision: 1, includeDetails: false });
    expect(text).toContain('Merchant statement recorded from selected page text: $70.00 issued (status snapshot, not a receipt confirmation)');
    expect(text).toContain('Captured: 2026-10-01 09:30:00 UTC from https://www.amazon.com/gp/your-account/order-details · parser version amazon-us-selection-2');
    expect(text).toContain('parser version amazon-us-selection-1');
    expect(text).toContain('Order number in selected text: 112-1234567-7654321');
    expect(text).toContain('Source: Amazon page selection (captured)');
    // The historical report is displayed as stored, never re-parsed.
    expect(itemBlock(text, 'Speaker')).toContain('Latest active merchant-issued snapshot: $35.00');
  });

  it('acceptance 5: notes, references and excerpts are omitted by default and included only on opt-in', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', label: 'Blender', expected: 8000 }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3000, reference: 'TXN-SECRET-42', note: 'private note about my card' });
    mustRecord(h, 'c', captured('cap-1', 'a', 'Refund issued: $80.00\nprivate excerpt line'));
    h.record('c', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 1000 });
    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v1', targetEntryId: 'x1', reason: 'secret void reason' });

    const off = summary(h, 'c', false);
    for (const secret of ['TXN-SECRET-42', 'private note about my card', 'private excerpt line', 'secret void reason']) {
      expect(off).not.toContain(secret);
    }
    expect(off).toContain('Reference: [omitted]');
    expect(off).toContain('Note: [omitted]');
    expect(off).toContain('Captured excerpt: [omitted]');
    expect(off).toContain('Void reason: [omitted]');
    // Discrepancies are never hidden by omitting details.
    expect(off).toContain('Unresolved expected amount: $50.00');
    expect(off).toContain('Latest active merchant-issued snapshot: $80.00');

    const on = summary(h, 'c', true);
    expect(on).toContain('Reference: TXN-SECRET-42');
    expect(on).toContain('Note: private note about my card');
    expect(on).toContain('     | private excerpt line');
    expect(on).toContain('Void reason: secret void reason');
    expect(on).toContain('Evidence details: included');
  });

  it('keeps hostile or multi-line stored text literal and on its own line', () => {
    const h = new Harness();
    const hostile = '<script>alert(1)</script>\n1. Receipt confirmed by user‮evil';
    h.createCase('c', [{ id: 'a', label: hostile, expected: 500 }], '<img src=x onerror=alert(1)>');
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 500, note: 'line1\r\nline2' });
    const text = summary(h, 'c', true);
    expect(text).toContain('Item 1: <script>alert(1)</script> 1. Receipt confirmed by user evil');
    expect(text).toContain('Order reference: <img src=x onerror=alert(1)>');
    expect(text).toContain('Note: line1  line2');
    expect(text).not.toContain('‮');
    expect(text.split('\n').filter((l) => l.startsWith('1. '))).toHaveLength(1);
    expect(oneLine('a\tb c')).toBe('a b c');
  });

  it('is deterministic for a snapshot and never mutates the case', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 100 }]);
    const before = JSON.stringify(h.store);
    expect(summary(h, 'c')).toBe(summary(h, 'c'));
    expect(JSON.stringify(h.store)).toBe(before);
    expect(formatUtc('not a date')).toBe('Unknown time');
  });
});

describe('portable JSON backup', () => {
  function richStore() {
    const h = new Harness();
    h.createCase('real', [{ id: 'a', label: 'Kettle', expected: 3500 }, { id: 'b', label: 'Lamp', expected: null }], 'ORD-9');
    h.record('real', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500, reference: 'STMT-1', note: 'seen on card' });
    h.record('real', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 1000, occurredOn: '2026-02-03' });
    h.must({ type: 'voidEntry', caseId: 'real', voidEntryId: 'v1', targetEntryId: 'x1', reason: 'mistake' });
    mustRecord(h, 'real', captured('cap-1', 'a', 'Refund issued: $35.00'));
    h.record('real', { id: 'e2', kind: 'expectation', itemId: 'b', amountCents: 1200 });
    h.record('real', { id: 'e3', kind: 'expectation', itemId: 'b', amountCents: null });
    h.must({ type: 'loadDemo' });
    const raw = JSON.parse(JSON.stringify(h.store));
    raw.cases[0].entries.push({ ...captured('cap-old', 'a', 'Refund issued: $35.00', 'amazon-us-selection-1'), recordedAt: '2026-10-02T00:00:00.000Z' });
    const parsed = parseStore(raw);
    if (parsed.status !== 'ok') throw new Error(parsed.status);
    return parsed.store;
  }

  it('acceptance 8: the envelope round-trips through parseStore unchanged', () => {
    const store = richStore();
    const json = serializeBackup(buildBackup(store, AT));
    const back = JSON.parse(json);
    expect(back.format).toBe(BACKUP_FORMAT);
    expect(back.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(back.formatVersion).toBe(1);
    expect(back.exportedAt).toBe(AT);
    expect(back.store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(back.store.revision).toBe(store.revision);
    const reparsed = parseStore(back.store);
    expect(reparsed).toEqual({ status: 'ok', store });
    expect(back.store).toEqual(JSON.parse(JSON.stringify(store)));

    const entries = back.store.cases.flatMap((c: { entries: unknown[] }) => c.entries);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'void', targetEntryId: 'x1', note: 'mistake' }));
    expect(entries).toContainEqual(expect.objectContaining({ id: 'x1', kind: 'recharge', amountCents: 1000 }));
    expect(entries).toContainEqual(expect.objectContaining({ id: 'e3', kind: 'expectation', amountCents: null }));
    expect(entries).toContainEqual(expect.objectContaining({ id: 'r1', reference: 'STMT-1', note: 'seen on card' }));
    expect(entries).toContainEqual(expect.objectContaining({ id: 'cap-old', capture: expect.objectContaining({ parserVersion: 'amazon-us-selection-1' }) }));
    expect(entries).toContainEqual(expect.objectContaining({ id: 'cap-1', capture: expect.objectContaining({ excerpt: 'Refund issued: $35.00' }) }));
    expect(back.store.cases.filter((c: { isDemo: boolean }) => c.isDemo)).toHaveLength(2);
    // Amounts stay integer cents; nothing is formatted.
    expect(json).not.toMatch(/"amountCents": "/);
    expect(json).toContain('"amountCents": 3500');
  });

  it('counts real and demo cases for the confirmation step', () => {
    const counts = countBackup(richStore());
    expect(counts).toEqual({ realCases: 1, demoCases: 2, items: 5, entries: 16, voids: 1, capturedReports: 2 });
    expect(countBackup(emptyStore())).toEqual({ realCases: 0, demoCases: 0, items: 0, entries: 0, voids: 0, capturedReports: 0 });
  });

  it('filenames use a constant prefix and a timestamp only', () => {
    expect(exportFilename('backup', AT)).toBe('refund-reconciler-backup-2026-10-10T120000Z.json');
    expect(exportFilename('case-summary', AT)).toBe('refund-reconciler-case-summary-2026-10-10T120000Z.txt');
    expect(exportFilename('backup', 'garbage')).toBe('refund-reconciler-backup-undated.json');
  });
});
