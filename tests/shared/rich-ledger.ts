// A SYNTHETIC ledger used by restore tests: manual receipts and recharges, a
// void, expected-amount changes, an unknown amount, current and historical
// parser-version captures (one that the current parser would refuse), hostile
// text and synthetic demo cases. Built through the real ledger commands, then
// one historical capture is added as stored data, as an older build wrote it.

import { analyzeExcerpt } from '../../src/capture/parse';
import { CAPTURE_SOURCE } from '../../src/domain/validate';
import type { RecordEntryCommand } from '../../src/domain/types';
import { Harness } from '../unit/helpers';

export const HOSTILE_LABEL = '<img src=x onerror="window.__pwned=1">Kettle';
export const HOSTILE_NOTE = '<script>window.__pwned=2</script> PRIVATE-NOTE-RESTORE';
/** Refused by the current parser (order-level wording), accepted as stored history. */
export const HISTORICAL_REFUSED_EXCERPT = 'Refund issued: $35.00 for this order';

export function capturedEntry(id: string, itemId: string, excerpt: string): RecordEntryCommand['entry'] {
  const a = analyzeExcerpt(excerpt);
  if (!a.issued) throw new Error(`fixture must parse: ${a.problems.join(',')}`);
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
    },
  };
}

/** Returns the raw (JSON) stored ledger. */
export function richLedger(): Record<string, unknown> & { revision: number; cases: Record<string, unknown>[] } {
  const h = new Harness();
  h.createCase('real-1', [{ id: 'a', label: HOSTILE_LABEL, expected: 3500 }, { id: 'b', label: 'Synthetic lamp', expected: null }], '112-1234567-7654321');
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 2000, occurredOn: '2026-09-02', source: 'Manual confirmation', note: HOSTILE_NOTE, reference: 'STMT-1' } });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 1000, occurredOn: null, source: 'Manual entry', note: '', reference: null } });
  h.must({ type: 'voidEntry', caseId: 'real-1', voidEntryId: 'v1', targetEntryId: 'x1', reason: 'Different order' });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'x2', kind: 'recharge', itemId: 'a', amountCents: 500, occurredOn: '2026-09-05', source: 'Card statement', note: 'clawback', reference: 'STMT-2' } });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: capturedEntry('cap-new', 'a', 'Order # 112-1234567-7654321\nRefund issued: $35.00') });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'e2', kind: 'expectation', itemId: 'b', amountCents: 1200, occurredOn: null, source: 'Manual entry', note: '', reference: null } });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'e3', kind: 'expectation', itemId: 'b', amountCents: null, occurredOn: null, source: 'Manual entry', note: 'not sure any more', reference: null } });
  h.createCase('real-2', [{ id: 'c', label: 'Synthetic chair', expected: 9000 }]);
  h.must({ type: 'recordEntry', caseId: 'real-2', entry: { id: 'r2', kind: 'receipt', itemId: 'c', amountCents: 9000, occurredOn: null, source: 'Manual confirmation', note: '', reference: 'STMT-9' } });
  h.must({ type: 'loadDemo' });
  const raw = JSON.parse(JSON.stringify(h.store));
  // Historical captures written by the previous parser version, kept exactly as stored.
  const old = capturedEntry('cap-old', 'a', 'Refund issued: $35.00');
  raw.cases[0].entries.push({ ...old, capture: { ...old.capture, parserVersion: 'amazon-us-selection-1' }, recordedAt: '2026-10-02T00:00:00.000Z' });
  raw.cases[0].entries.push({
    id: 'cap-hist',
    kind: 'merchant_report',
    itemId: 'b',
    amountCents: 3500,
    recordedAt: '2026-10-03T00:00:00.000Z',
    occurredOn: null,
    source: CAPTURE_SOURCE,
    note: '',
    reference: null,
    capture: {
      sourceOrigin: 'https://amazon.com',
      sourcePath: null,
      capturedAt: '2026-10-03T00:00:00.000Z',
      excerpt: HISTORICAL_REFUSED_EXCERPT,
      parserVersion: 'amazon-us-selection-1',
      approvedAmountText: '$35.00',
      detectedOrderRef: null,
      itemApplicabilityConfirmed: true,
    },
  });
  raw.cases[0].updatedAt = '2026-10-03T00:00:00.000Z';
  return raw;
}
