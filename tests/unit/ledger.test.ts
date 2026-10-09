import { describe, expect, it } from 'vitest';
import { summarizeCase } from '../../src/domain/reconcile';
import { applyCommand } from '../../src/domain/ledger';
import { emptyStore } from '../../src/domain/types';
import { Harness } from './helpers';

describe('idempotent ingestion (acceptance 4)', () => {
  it('repeating the same entry id with the same contents does not double-count', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    const first = h.record('c', { id: 'txn-1', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    const revision = h.store.revision;
    const again = h.record('c', { id: 'txn-1', kind: 'receipt', itemId: 'a', amountCents: 3500 });

    expect(first.ok && first.outcome).toBe('applied');
    expect(again.ok && again.outcome).toBe('duplicate');
    expect(h.store.revision).toBe(revision);
    expect(summarizeCase(h.case('c')).items[0]?.confirmedReceivedCents).toBe(3500);
  });

  it('reusing an entry id with different contents is a conflict and keeps the original', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    h.record('c', { id: 'txn-1', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    const before = h.store;
    const conflict = h.record('c', { id: 'txn-1', kind: 'receipt', itemId: 'a', amountCents: 9900 });

    expect(conflict).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(h.store).toBe(before);
    expect(h.case('c').entries.find((e) => e.id === 'txn-1')).toMatchObject({ amountCents: 3500 });
  });

  it('the same transaction reference is idempotent when contents match and conflicts otherwise', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }, { id: 'b', expected: 7000 }]);
    h.record('c', { id: 'e1', kind: 'receipt', itemId: 'a', amountCents: 3500, reference: 'BANK-77' });
    const same = h.record('c', { id: 'e2', kind: 'receipt', itemId: 'a', amountCents: 3500, reference: 'BANK-77' });
    expect(same.ok && same.outcome).toBe('duplicate');
    expect(h.case('c').entries.filter((e) => e.kind === 'receipt')).toHaveLength(1);

    const otherItem = h.record('c', { id: 'e3', kind: 'receipt', itemId: 'b', amountCents: 3500, reference: 'BANK-77' });
    expect(otherItem).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const otherAmount = h.record('c', { id: 'e4', kind: 'receipt', itemId: 'a', amountCents: 100, reference: 'BANK-77' });
    expect(otherAmount).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('a voided reference can be recorded again with corrected details', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    h.record('c', { id: 'e1', kind: 'receipt', itemId: 'a', amountCents: 350, reference: 'BANK-1' });
    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v1', targetEntryId: 'e1', reason: 'Typo' });
    const fixed = h.record('c', { id: 'e2', kind: 'receipt', itemId: 'a', amountCents: 3500, reference: 'BANK-1' });
    expect(fixed.ok && fixed.outcome).toBe('applied');
    expect(summarizeCase(h.case('c')).status).toBe('settled');
  });

  it('re-creating the same case id is idempotent; a different case with that id conflicts', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    const again = h.apply({ type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'Item a', expectedCents: 3500, expectationEntryId: 'exp-c-a' }] });
    expect(again.ok && again.outcome).toBe('duplicate');
    const different = h.apply({ type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'Item a', expectedCents: 100, expectationEntryId: 'exp-c-a' }] });
    expect(different).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});

describe('distinct evidence stays distinct (acceptance 5)', () => {
  it('separate orders with equal amounts are not merged', () => {
    const h = new Harness();
    h.createCase('order-1', [{ id: 'a1', expected: 3500 }], '111-1');
    h.createCase('order-2', [{ id: 'a2', expected: 3500 }], '222-2');
    h.record('order-1', { id: 'r1', kind: 'receipt', itemId: 'a1', amountCents: 3500 });

    expect(summarizeCase(h.case('order-1')).status).toBe('settled');
    expect(summarizeCase(h.case('order-2')).status).toBe('open');
    expect(summarizeCase(h.case('order-2')).unresolvedCents).toBe(3500);
  });

  it('distinct same-amount transactions on one item are both counted', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 7000 }]);
    h.record('c', { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    h.record('c', { id: 'r2', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    const item = summarizeCase(h.case('c')).items[0];
    expect(item?.confirmedReceivedCents).toBe(7000);
    expect(item?.status).toBe('settled');
  });

  it('evidence must name an item that belongs to the case', () => {
    const h = new Harness();
    h.createCase('c1', [{ id: 'a', expected: 3500 }]);
    h.createCase('c2', [{ id: 'b', expected: 3500 }]);
    const wrong = h.record('c1', { id: 'r', kind: 'receipt', itemId: 'b', amountCents: 3500 });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('ledger rules', () => {
  it('rejects zero receipts and recharges but allows a zero merchant report', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    expect(h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 0 }).ok).toBe(false);
    expect(h.record('c', { id: 'x', kind: 'recharge', itemId: 'a', amountCents: 0 }).ok).toBe(false);
    expect(h.record('c', { id: 'm', kind: 'merchant_report', itemId: 'a', amountCents: 0 }).ok).toBe(true);
  });

  it('cannot void an expectation, a void, or the same entry twice', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    expect(h.apply({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v0', targetEntryId: 'exp-c-a', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'not_voidable' } });
    h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v1', targetEntryId: 'r', reason: 'x' });
    expect(h.apply({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v2', targetEntryId: 'r', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'already_voided' } });
    expect(h.apply({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v3', targetEntryId: 'v1', reason: 'x' })).toMatchObject({ ok: false, error: { code: 'not_voidable' } });
    // Resubmitting the identical void is a no-op.
    const again = h.apply({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v1', targetEntryId: 'r', reason: 'x' });
    expect(again.ok && again.outcome).toBe('duplicate');
  });

  it('an unchanged expected amount records nothing', () => {
    const h = new Harness();
    h.createCase('c', [{ id: 'a', expected: 3500 }]);
    const r = h.record('c', { id: 'e2', kind: 'expectation', itemId: 'a', amountCents: 3500 });
    expect(r.ok && r.outcome).toBe('unchanged');
    expect(h.case('c').entries).toHaveLength(1);
  });

  it('never mutates the input store', () => {
    const store = Object.freeze(emptyStore());
    const r = applyCommand(store, { type: 'createCase', caseId: 'c', orderRef: null, items: [{ itemId: 'a', label: 'A', expectedCents: 1, expectationEntryId: 'e' }] }, '2026-01-01T00:00:00.000Z');
    expect(r.ok).toBe(true);
    expect(store.cases).toHaveLength(0);
  });

  it('deleting a case removes it and all its evidence', () => {
    const h = new Harness();
    h.createCase('c1', [{ id: 'a', expected: 3500 }]);
    h.createCase('c2', [{ id: 'b', expected: 3500 }]);
    h.record('c1', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 3500 });
    h.must({ type: 'deleteCase', caseId: 'c1' });
    expect(h.store.cases.map((c) => c.id)).toEqual(['c2']);
    expect(JSON.stringify(h.store)).not.toContain('"r"');
  });

  it('demo cases are flagged synthetic, loaded once and removable without touching real cases', () => {
    const h = new Harness();
    h.createCase('real', [{ id: 'a', expected: 3500 }]);
    h.must({ type: 'loadDemo' });
    const demo = h.store.cases.filter((c) => c.isDemo);
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.every((c) => c.entries.every((e) => e.source === 'Synthetic demo'))).toBe(true);
    const again = h.apply({ type: 'loadDemo' });
    expect(again.ok && again.outcome).toBe('unchanged');
    h.must({ type: 'removeDemo' });
    expect(h.store.cases.map((c) => c.id)).toEqual(['real']);
  });

  it('the synthetic demo shows partial and recharge scenarios', () => {
    const h = new Harness();
    h.must({ type: 'loadDemo' });
    const statuses = h.store.cases.map((c) => summarizeCase(c).status);
    expect(statuses).toEqual(['open', 'needs_review']);
  });
});
