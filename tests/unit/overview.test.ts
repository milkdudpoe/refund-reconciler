import { describe, expect, it } from 'vitest';
import {
  QUERY_MAX,
  STATUS_FILTERS,
  buildOverview,
  caseMatchesQuery,
  findCases,
  normalizeQuery,
  realCaseViews,
  type StatusFilter,
} from '../../src/domain/overview';
import { MAX_INPUT_CENTS } from '../../src/domain/money';
import { summarizeCase } from '../../src/domain/reconcile';
import type { CaseRecord, Entry } from '../../src/domain/types';
import { capturedEntry } from '../shared/rich-ledger';
import { Harness } from './helpers';
import { MIXED_TOTALS, mixedLedger } from '../shared/overview-ledger';

function ids(cases: readonly { record: CaseRecord }[]): string[] {
  return cases.map((v) => v.record.id).sort();
}

function membership(h: Harness, status: StatusFilter): string[] {
  return ids(findCases(realCaseViews(h.store.cases), { query: '', status }));
}

describe('overview totals (acceptance 1)', () => {
  it('sums real unresolved amounts per existing reconciliation, counts unknowns, attention and review, and excludes demo', () => {
    const h = mixedLedger();
    const o = buildOverview(realCaseViews(h.store.cases));
    // 1500 + 7000 + 0 + 1000 + 3000 (the $5 excess does NOT offset it) + 1500 + 0
    const { unresolvedCents, ...counts } = MIXED_TOTALS;
    expect(o).toEqual({ ...counts, unresolved: { ok: true, cents: unresolvedCents } });

    // Same answer as adding each case's own summary: no separate financial rule.
    const perCase = h.store.cases.filter((c) => !c.isDemo).reduce((n, c) => n + summarizeCase(c).unresolvedCents, 0);
    expect(perCase).toBe(14000);
    // The demo has its own unresolved amounts, which must not appear.
    expect(h.store.cases.filter((c) => c.isDemo).reduce((n, c) => n + summarizeCase(c).unresolvedCents, 0)).toBeGreaterThan(0);
  });

  it('puts each case in the right status group, including a balanced contradiction', () => {
    const h = mixedLedger();
    expect(summarizeCase(h.case('conflict')).unresolvedCents).toBe(0);
    expect(membership(h, 'all')).toEqual(['conflict', 'issued', 'partial', 'reopened', 'settled', 'split', 'unknown']);
    expect(membership(h, 'attention')).toEqual(['conflict', 'issued', 'partial', 'reopened', 'split', 'unknown']);
    expect(membership(h, 'review')).toEqual(['conflict', 'reopened', 'split']);
    expect(membership(h, 'settled')).toEqual(['settled']);
  });

  it('a demo-only ledger has no real totals', () => {
    const h = new Harness();
    h.must({ type: 'loadDemo' });
    expect(buildOverview(realCaseViews(h.store.cases))).toEqual({ caseCount: 0, unresolved: { ok: true, cents: 0 }, unknownItemCount: 0, attentionCount: 0, reviewCount: 0 });
    // Even if handed demo views directly, they are not counted.
    const demoViews = h.store.cases.map((record) => ({ record, summary: summarizeCase(record) }));
    expect(buildOverview(demoViews).caseCount).toBe(0);
    expect(findCases(demoViews, { query: 'synthetic', status: 'all' })).toEqual([]);
  });
});

describe('snapshots, voids and unrepresentable totals (acceptance 2)', () => {
  it('several merchant-report snapshots never inflate confirmed receipts or the overview', () => {
    const h = new Harness();
    h.createCase('snap', [{ id: 'a', label: 'Speaker', expected: 9000 }], 'SNAP-1');
    const before = buildOverview(realCaseViews(h.store.cases));
    for (const [n, cents] of [2000, 9000, 9000, 9000].entries()) {
      h.record('snap', { id: `m${n}`, kind: 'merchant_report', itemId: 'a', amountCents: cents });
    }
    h.must({ type: 'recordEntry', caseId: 'snap', entry: capturedEntry('cap', 'a', 'Refund issued: $90.00') });
    const after = buildOverview(realCaseViews(h.store.cases));
    expect(before.unresolved).toEqual({ ok: true, cents: 9000 });
    expect(after).toEqual(before);
    expect(summarizeCase(h.case('snap')).netConfirmedCents).toBe(0);
    expect(membership(h, 'settled')).toEqual([]);
  });

  it('voids change totals and membership through the normal derivation', () => {
    const h = mixedLedger();
    // Voiding the settled case's receipt reopens it.
    h.must({ type: 'voidEntry', caseId: 'settled', voidEntryId: 'v1', targetEntryId: 's-r1', reason: 'Wrong order' });
    // Voiding the conflicting merchant report clears the review condition.
    h.must({ type: 'voidEntry', caseId: 'conflict', voidEntryId: 'v2', targetEntryId: 'c-m1', reason: 'Misread' });
    const o = buildOverview(realCaseViews(h.store.cases));
    expect(o.unresolved).toEqual({ ok: true, cents: 18000 });
    expect(o.attentionCount).toBe(6);
    expect(o.reviewCount).toBe(2);
    expect(membership(h, 'settled')).toEqual(['conflict']);
    expect(membership(h, 'attention')).toContain('settled');
    // The voided entries are still in the history.
    expect(h.case('settled').entries.map((e) => e.id)).toEqual(['exp-settled-s1', 's-r1', 'v1']);
  });

  it('reports an unavailable total instead of an inexact sum, while each case stays usable', () => {
    // Two real cases whose own figures are exact but whose sum exceeds the safe-integer range.
    const recharges = 45_036;
    const huge = (id: string): CaseRecord => {
      const entries: Entry[] = [
        { id: `${id}-exp`, kind: 'expectation', itemId: `${id}-item`, amountCents: MAX_INPUT_CENTS, recordedAt: '2026-01-01T00:00:00.000Z', occurredOn: null, source: 'Test', note: '' },
      ];
      for (let i = 0; i < recharges; i++) {
        entries.push({ id: `${id}-x${i}`, kind: 'recharge', itemId: `${id}-item`, amountCents: MAX_INPUT_CENTS, recordedAt: '2026-01-01T00:00:00.000Z', occurredOn: null, source: 'Test', note: '', reference: null });
      }
      return { id, retailer: 'amazon_us', orderRef: id, currency: 'USD', isDemo: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', items: [{ id: `${id}-item`, label: 'Synthetic', createdAt: '2026-01-01T00:00:00.000Z' }], entries };
    };
    const h = mixedLedger();
    const views = realCaseViews([...h.store.cases, huge('big-1'), huge('big-2')]);
    for (const v of views) expect(Number.isSafeInteger(v.summary.unresolvedCents)).toBe(true);
    const o = buildOverview(views);
    expect(o.unresolved).toEqual({ ok: false });
    expect(o.caseCount).toBe(9);
    expect(o.attentionCount).toBe(8);
    expect(o.reviewCount).toBe(5);
    expect(findCases(views, { query: 'big-', status: 'review' })).toHaveLength(2);
  });
});

describe('search and display order (acceptance 3)', () => {
  it('matches order references and item descriptions literally, ignoring case and surrounding space', () => {
    const h = mixedLedger();
    const views = realCaseViews(h.store.cases);
    const find = (query: string, status: StatusFilter = 'all') => ids(findCases(views, { query, status }));
    expect(find('blue kettle')).toEqual(['partial']);
    expect(find('  BLUE KeTTLE \n')).toEqual(['partial']);
    expect(find('111-0000006')).toEqual(['reopened']);
    expect(find('rain')).toEqual(['split']);
    expect(find('hose')).toEqual(['unknown']);
    expect(find('   ')).toEqual(find(''));
    expect(find('')).toHaveLength(7);
    expect(find('not present anywhere')).toEqual([]);
    // Combined with every status selection.
    expect(find('111-', 'all')).toEqual(['conflict', 'issued', 'partial', 'reopened', 'settled', 'split']);
    expect(find('111-', 'attention')).toEqual(['conflict', 'issued', 'partial', 'reopened', 'split']);
    expect(find('111-', 'review')).toEqual(['conflict', 'reopened', 'split']);
    expect(find('111-', 'settled')).toEqual(['settled']);
    expect(find('lamp', 'attention')).toEqual([]);
    expect(find('lamp', 'settled')).toEqual(['settled']);
    expect(STATUS_FILTERS).toEqual(['all', 'attention', 'review', 'settled']);
  });

  it('treats regex- and HTML-looking text literally', () => {
    const h = new Harness();
    h.createCase('odd', [{ id: 'a', label: 'Cable (2m) [USB-C]*', expected: 100 }, { id: 'b', label: '<b>Bold</b> mug', expected: 100 }], 'A.B+C');
    h.createCase('plain', [{ id: 'c', label: 'Cable 2m USB-C', expected: 100 }], 'AXBBC');
    const find = (query: string) => ids(findCases(realCaseViews(h.store.cases), { query, status: 'all' }));
    expect(find('(2m) [usb-c]*')).toEqual(['odd']);
    expect(find('.*')).toEqual([]);
    expect(find('a.b+c')).toEqual(['odd']);
    expect(find('<b>bold</b>')).toEqual(['odd']);
    expect(find('[')).toEqual(['odd']);
    expect(find('\\')).toEqual([]);
  });

  it('does not search notes, transaction references, sources or captured excerpts', () => {
    const h = new Harness();
    h.createCase('n', [{ id: 'a', label: 'Toaster', expected: 2500 }], 'ORD-1');
    h.record('n', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 500, note: 'SECRET-NOTE', reference: 'STMT-PRIVATE', source: 'Bank SOURCE-X' });
    h.must({ type: 'recordEntry', caseId: 'n', entry: capturedEntry('cap', 'a', 'Order # 112-9999999-9999999\nRefund issued: $25.00') });
    const c = h.case('n');
    for (const q of ['secret-note', 'stmt-private', 'source-x', '112-9999999', 'refund issued']) {
      expect(caseMatchesQuery(c, normalizeQuery(q))).toBe(false);
    }
    expect(caseMatchesQuery(c, normalizeQuery('toast'))).toBe(true);
  });

  it(`bounds the query at ${QUERY_MAX} characters without touching stored text`, () => {
    const long = 'k'.repeat(QUERY_MAX);
    expect(normalizeQuery(`${long}EXTRA`)).toBe(long);
    const h = new Harness();
    h.createCase('long', [{ id: 'a', label: `${long}z`, expected: 100 }]);
    expect(findCases(realCaseViews(h.store.cases), { query: `${long}not-used`, status: 'all' })).toHaveLength(1);
    expect(h.case('long').items[0]?.label).toBe(`${long}z`);
  });

  it('orders by last update, newest first, with an id tie-break, and never reorders the input', () => {
    const h = mixedLedger();
    // Touch an older case so it moves to the top of the display order only.
    h.record('partial', { id: 'p-r2', kind: 'receipt', itemId: 'p1', amountCents: 100 });
    const stored = JSON.stringify(h.store);
    const views = realCaseViews(h.store.cases);
    const viewOrder = views.map((v) => v.record.id);
    const shown = findCases(views, { query: '', status: 'all' }).map((v) => v.record.id);
    expect(shown).toEqual(['partial', 'conflict', 'reopened', 'split', 'unknown', 'settled', 'issued']);
    expect(views.map((v) => v.record.id)).toEqual(viewOrder);
    expect(JSON.stringify(h.store)).toBe(stored);

    const same = '2026-05-05T00:00:00.000Z';
    const tied = ['c-3', 'c-1', 'c-2'].map((id) => ({ ...h.case('settled'), id, updatedAt: same }));
    expect(findCases(realCaseViews(tied), { query: '', status: 'all' }).map((v) => v.record.id)).toEqual(['c-1', 'c-2', 'c-3']);
    expect(findCases(realCaseViews([...tied].reverse()), { query: '', status: 'all' }).map((v) => v.record.id)).toEqual(['c-1', 'c-2', 'c-3']);
  });
});
