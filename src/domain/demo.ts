// Clearly labelled synthetic examples. Loaded only when the user asks, stored
// with isDemo=true, and shown apart from real cases.

import type { CreateCaseCommand, RecordEntryCommand } from './types';

export interface DemoCase {
  readonly create: CreateCaseCommand;
  readonly entries: readonly RecordEntryCommand['entry'][];
}

const SOURCE = 'Synthetic demo';

export function buildDemoCases(): readonly DemoCase[] {
  return [
    {
      create: {
        type: 'createCase',
        caseId: 'demo-case-partial',
        orderRef: 'SYNTHETIC-0001',
        items: [
          { itemId: 'demo-item-a', label: 'Synthetic item A (demo)', expectedCents: 3500, expectationEntryId: 'demo-exp-a' },
          { itemId: 'demo-item-b', label: 'Synthetic item B (demo)', expectedCents: 3500, expectationEntryId: 'demo-exp-b' },
        ],
      },
      entries: [
        { id: 'demo-report-a', kind: 'merchant_report', itemId: 'demo-item-a', amountCents: 3500, occurredOn: '2026-01-05', source: SOURCE, note: 'Synthetic merchant status', reference: null },
        { id: 'demo-receipt-a', kind: 'receipt', itemId: 'demo-item-a', amountCents: 3500, occurredOn: '2026-01-08', source: SOURCE, note: 'Synthetic confirmation', reference: null },
      ],
    },
    {
      create: {
        type: 'createCase',
        caseId: 'demo-case-recharge',
        orderRef: 'SYNTHETIC-0002',
        items: [{ itemId: 'demo-item-c', label: 'Synthetic item C (demo)', expectedCents: 7000, expectationEntryId: 'demo-exp-c' }],
      },
      entries: [
        { id: 'demo-receipt-c', kind: 'receipt', itemId: 'demo-item-c', amountCents: 7000, occurredOn: '2026-02-01', source: SOURCE, note: 'Synthetic confirmation', reference: null },
        { id: 'demo-recharge-c', kind: 'recharge', itemId: 'demo-item-c', amountCents: 2000, occurredOn: '2026-02-20', source: SOURCE, note: 'Synthetic recharge', reference: null },
      ],
    },
  ];
}
