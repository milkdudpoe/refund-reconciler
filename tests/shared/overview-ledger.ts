// A mixed SYNTHETIC real ledger plus the synthetic demo, shared by the overview
// unit and browser tests. Built through the real ledger commands.

import { Harness } from '../unit/helpers';

/**
 * A mixed SYNTHETIC real ledger plus the synthetic demo:
 *   partial      $35 expected, $20 confirmed            → $15 unresolved, open
 *   issued       $70 expected, merchant reports $70     → $70 unresolved, open (report is not a receipt)
 *   settled      $40 expected, $40 confirmed            → settled
 *   unknown      unknown + $10 expected                 → $10 unresolved, 1 unknown, open
 *   split        $20 item with $25 confirmed (excess) + $30 item with nothing → $30 unresolved, needs review
 *   reopened     $50 confirmed, $15 recharged           → $15 unresolved, needs review
 *   conflict     $60 confirmed, merchant reports $40    → $0 unresolved, needs review
 */
export function mixedLedger(): Harness {
  const h = new Harness();
  h.createCase('partial', [{ id: 'p1', label: 'Blue Kettle', expected: 3500 }], '111-0000001-0000001');
  h.record('partial', { id: 'p-r1', kind: 'receipt', itemId: 'p1', amountCents: 2000 });

  h.createCase('issued', [{ id: 'i1', label: 'Headphones', expected: 7000 }], '111-0000002-0000002');
  h.record('issued', { id: 'i-m1', kind: 'merchant_report', itemId: 'i1', amountCents: 7000 });

  h.createCase('settled', [{ id: 's1', label: 'Desk lamp', expected: 4000 }], '111-0000003-0000003');
  h.record('settled', { id: 's-r1', kind: 'receipt', itemId: 's1', amountCents: 4000 });

  h.createCase('unknown', [{ id: 'u1', label: 'Garden hose', expected: null }, { id: 'u2', label: 'Hose nozzle', expected: 1000 }]);

  h.createCase('split', [{ id: 'x1', label: 'Rain jacket', expected: 2000 }, { id: 'x2', label: 'Rain trousers', expected: 3000 }], '111-0000005-0000005');
  h.record('split', { id: 'x-r1', kind: 'receipt', itemId: 'x1', amountCents: 2500 });

  h.createCase('reopened', [{ id: 'r1', label: 'Office chair', expected: 5000 }], '111-0000006-0000006');
  h.record('reopened', { id: 'r-r1', kind: 'receipt', itemId: 'r1', amountCents: 5000 });
  h.record('reopened', { id: 'r-x1', kind: 'recharge', itemId: 'r1', amountCents: 1500 });

  h.createCase('conflict', [{ id: 'c1', label: 'Monitor stand', expected: 6000 }], '111-0000007-0000007');
  h.record('conflict', { id: 'c-r1', kind: 'receipt', itemId: 'c1', amountCents: 6000 });
  h.record('conflict', { id: 'c-m1', kind: 'merchant_report', itemId: 'c1', amountCents: 4000 });

  h.must({ type: 'loadDemo' });
  return h;
}

/** Expected overview of mixedLedger(), from the existing reconciliation semantics. */
export const MIXED_TOTALS = { caseCount: 7, unresolvedCents: 14000, unknownItemCount: 1, attentionCount: 6, reviewCount: 3 } as const;
