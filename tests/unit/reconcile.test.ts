import { describe, expect, it } from 'vitest';
import { buildTimeline, summarizeCase } from '../../src/domain/reconcile';
import { Harness } from './helpers';

function item(h: Harness, caseId: string, itemId: string) {
  const s = summarizeCase(h.case(caseId)).items.find((i) => i.item.id === itemId);
  if (!s) throw new Error('missing item');
  return s;
}

describe('acceptance examples', () => {
  it('1. partial confirmation: item A settled, item B unconfirmed, $35 unresolved', () => {
    const h = new Harness();
    h.createCase('c1', [{ id: 'a', expected: 3500 }, { id: 'b', expected: 3500 }]);
    h.record('c1', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500 });

    const summary = summarizeCase(h.case('c1'));
    expect(item(h, 'c1', 'a').status).toBe('settled');
    expect(item(h, 'c1', 'b').status).toBe('unconfirmed');
    expect(item(h, 'c1', 'b').unresolvedCents).toBe(3500);
    expect(summary.status).toBe('open');
    expect(summary.unresolvedCents).toBe(3500);
    expect(summary.netConfirmedCents).toBe(3500);
  });

  it('2. merchant reports $70 issued but nothing confirmed: issued/unconfirmed, never settled', () => {
    const h = new Harness();
    h.createCase('c2', [{ id: 'a', expected: 7000 }]);
    h.record('c2', { id: 'm1', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });

    const a = item(h, 'c2', 'a');
    expect(a.status).toBe('issued_unconfirmed');
    expect(a.merchantReportedCents).toBe(7000);
    expect(a.netConfirmedCents).toBe(0);
    expect(a.unresolvedCents).toBe(7000);
    expect(a.flags).toContain('merchant_reports_more_than_confirmed');
    expect(summarizeCase(h.case('c2')).status).not.toBe('settled');
  });

  it('2b. repeated merchant status reports are snapshots, not summed', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    h.record('c', { id: 'm1', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });
    h.record('c', { id: 'm2', kind: 'merchant_report', itemId: 'a', amountCents: 7000 });
    expect(item(h, 'c', 'a').merchantReportedCents).toBe(7000);
    h.record('c', { id: 'm3', kind: 'merchant_report', itemId: 'a', amountCents: 5000 });
    expect(item(h, 'c', 'a').merchantReportedCents).toBe(5000);
  });

  it('3. a later recharge reopens a settled case: $50 net, $20 difference', () => {
    const h = new Harness();
    h.createCase('c3', [{ id: 'a', expected: 7000 }]);
    h.record('c3', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 7000 });
    expect(summarizeCase(h.case('c3')).status).toBe('settled');

    h.record('c3', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 2000 });
    const a = item(h, 'c3', 'a');
    expect(a.status).toBe('reopened');
    expect(a.netConfirmedCents).toBe(5000);
    expect(a.differenceCents).toBe(2000);
    const summary = summarizeCase(h.case('c3'));
    expect(summary.status).toBe('needs_review');
    expect(summary.unresolvedCents).toBe(2000);
  });

  it('6. unknown expectations give unknown differences and no false all-clear', () => {
    const h = new Harness();
    h.createCase('c6', [{ id: 'a', expected: null }, { id: 'b', expected: 3500 }]);
    h.record('c6', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 1000 });
    h.record('c6', { id: 'r2', kind: 'receipt', itemId: 'b', amountCents: 3500 });

    const a = item(h, 'c6', 'a');
    expect(a.expectedCents).toBeNull();
    expect(a.differenceCents).toBeNull();
    expect(a.unresolvedCents).toBeNull();
    expect(a.status).toBe('expectation_unknown');
    expect(a.flags).toContain('receipts_without_expectation');
    const summary = summarizeCase(h.case('c6'));
    expect(summary.status).toBe('open');
    expect(summary.unknownExpectationCount).toBe(1);
    // Unknown is not treated as zero: the known total excludes it rather than counting $0.
    expect(summary.knownExpectedCents).toBe(3500);
  });

  it('6b. no confirmations is "unconfirmed", not "nothing received" or settled', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 1500 }]);
    const a = item(h, 'c', 'a');
    expect(a.status).toBe('unconfirmed');
    expect(summarizeCase(h.case('c')).status).toBe('open');
  });

  it('7. an over-receipt on one item does not settle another', () => {
    const h = new Harness();
    h.createCase('c7', [{ id: 'a', expected: 3500 }, { id: 'b', expected: 3500 }]);
    h.record('c7', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 7000 });

    expect(item(h, 'c7', 'a').status).toBe('excess');
    expect(item(h, 'c7', 'a').excessCents).toBe(3500);
    expect(item(h, 'c7', 'b').status).toBe('unconfirmed');
    const summary = summarizeCase(h.case('c7'));
    expect(summary.status).toBe('needs_review');
    expect(summary.unresolvedCents).toBe(3500);
    expect(summary.excessCents).toBe(3500);
    // Net confirmed equals the known expected total, but the case is still not settled.
    expect(summary.netConfirmedCents).toBe(summary.knownExpectedCents);
  });

  it('9. voiding an entry updates calculations and keeps the original evidence', () => {
    const h = new Harness();
    h.createCase('c9', [{ id: 'a', expected: 3500 }]);
    h.record('c9', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500, note: 'typo: wrong order' });
    expect(item(h, 'c9', 'a').status).toBe('settled');

    h.must({ type: 'voidEntry', caseId: 'c9', voidEntryId: 'v1', targetEntryId: 'r1', reason: 'Belonged to a different order' });
    const a = item(h, 'c9', 'a');
    expect(a.status).toBe('unconfirmed');
    expect(a.confirmedReceivedCents).toBe(0);

    const original = h.case('c9').entries.find((e) => e.id === 'r1');
    expect(original).toMatchObject({ kind: 'receipt', amountCents: 3500, note: 'typo: wrong order' });
    const timeline = buildTimeline(h.case('c9'));
    const row = timeline.find((r) => r.entry.id === 'r1');
    expect(row?.voidedBy?.id).toBe('v1');
    expect(timeline.map((r) => r.entry.kind)).toEqual(['expectation', 'receipt', 'void']);
  });

  it('voiding a recharge restores a settled state', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 7000 });
    h.record('c', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 2000 });
    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v', targetEntryId: 'x1', reason: 'Recorded in error' });
    expect(summarizeCase(h.case('c')).status).toBe('settled');
  });

  it('a recharge larger than receipts produces negative net, not clamped', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 1000 }]);
    h.record('c', { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 500 });
    const a = item(h, 'c', 'a');
    expect(a.netConfirmedCents).toBe(-500);
    expect(a.differenceCents).toBe(1500);
    expect(a.status).toBe('reopened');
  });

  it('merchant reporting less than confirmed receipts needs review', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3000 }]);
    h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 2000 });
    h.record('c', { id: 'm', kind: 'merchant_report', itemId: 'a', amountCents: 1000 });
    expect(item(h, 'c', 'a').flags).toContain('merchant_reports_less_than_confirmed');
    expect(summarizeCase(h.case('c')).status).toBe('needs_review');
  });

  it('expected-amount edits change derivations and appear in the timeline', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: null }]);
    h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 2500 });
    h.record('c', { id: 'e2', kind: 'expectation', itemId: 'a', amountCents: 2500 });
    expect(item(h, 'c', 'a').status).toBe('settled');
    h.record('c', { id: 'e3', kind: 'expectation', itemId: 'a', amountCents: 3000 });
    expect(item(h, 'c', 'a').unresolvedCents).toBe(500);

    const rows = buildTimeline(h.case('c')).filter((r) => r.entry.kind === 'expectation');
    expect(rows.map((r) => [r.previousExpectation, 'amountCents' in r.entry ? r.entry.amountCents : 'x'])).toEqual([
      [undefined, null],
      [null, 2500],
      [2500, 3000],
    ]);
  });

  it('expected amount of zero is a known value distinct from unknown', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 0 }]);
    expect(item(h, 'c', 'a').differenceCents).toBe(0);
    expect(item(h, 'c', 'a').status).toBe('settled');
  });
});
