// Pure derivations from the evidence log. Nothing here is stored; item and case
// states are always recomputed from entries so they cannot drift.

import { addCents, subtractCents, sumCents, type Cents } from './money';
import type { CaseRecord, Entry, ItemRecord } from './types';

export type ItemStatus =
  /** No usable expectation: the difference is unknown, not zero. */
  | 'expectation_unknown'
  /** Known expectation, nothing confirmed received, merchant has not reported issuing. */
  | 'unconfirmed'
  /** Merchant reports a refund issued, but the user has not confirmed receiving it. */
  | 'issued_unconfirmed'
  /** Some money confirmed, less than expected, no recharge involved. */
  | 'partial'
  /** A recharge brought confirmed net receipts below the expectation. */
  | 'reopened'
  /** Confirmed net receipts exceed the expectation. Kept for review, never offset. */
  | 'excess'
  /** Confirmed net receipts equal the known expectation. */
  | 'settled';

export type ItemFlag =
  /** The merchant's latest reported issued total is above confirmed net receipts. */
  | 'merchant_reports_more_than_confirmed'
  /** The merchant's latest reported issued total is below confirmed net receipts. */
  | 'merchant_reports_less_than_confirmed'
  /** Receipts were confirmed while the expectation is unknown. */
  | 'receipts_without_expectation';

export interface ItemSummary {
  readonly item: ItemRecord;
  readonly expectedCents: Cents | null;
  readonly confirmedReceivedCents: Cents;
  readonly rechargedCents: Cents;
  /** Confirmed receipts minus recharges. May be negative. */
  readonly netConfirmedCents: number;
  /** Latest active merchant report (a snapshot, not a sum), or null if none. */
  readonly merchantReportedCents: Cents | null;
  /** expected − net. Positive: unresolved expected amount. Negative: excess. Null: unknown. */
  readonly differenceCents: number | null;
  readonly unresolvedCents: Cents | null;
  readonly excessCents: Cents | null;
  readonly status: ItemStatus;
  readonly flags: readonly ItemFlag[];
}

export type CaseStatus =
  /** Every item's confirmed net receipts match its known expectation. */
  | 'settled'
  /** At least one item has an excess, a recharge reopening, or a conflicting merchant report. */
  | 'needs_review'
  /** Outstanding expected amounts or unknown expectations remain. */
  | 'open';

export interface CaseSummary {
  readonly status: CaseStatus;
  readonly items: readonly ItemSummary[];
  /** Sum of positive differences over items with known expectations. */
  readonly unresolvedCents: Cents;
  /** Sum of excess receipts. Never used to offset another item's unresolved amount. */
  readonly excessCents: Cents;
  readonly knownExpectedCents: Cents;
  readonly netConfirmedCents: number;
  readonly unknownExpectationCount: number;
  readonly settledCount: number;
}

export function activeEntries(caseRecord: CaseRecord): readonly Entry[] {
  const voided = new Set(caseRecord.entries.flatMap((e) => (e.kind === 'void' ? [e.targetEntryId] : [])));
  return caseRecord.entries.filter((e) => e.kind !== 'void' && !voided.has(e.id));
}

/** Latest expected amount for an item; undefined if none recorded, null if explicitly unknown. */
export function currentExpectation(caseRecord: CaseRecord, itemId: string): Cents | null | undefined {
  let expected: Cents | null | undefined;
  for (const e of caseRecord.entries) {
    if (e.kind === 'expectation' && e.itemId === itemId) expected = e.amountCents;
  }
  return expected;
}

export function summarizeItem(caseRecord: CaseRecord, item: ItemRecord): ItemSummary {
  const entries = activeEntries(caseRecord).filter((e) => e.itemId === item.id);
  const amounts = (kind: Entry['kind']) =>
    entries.flatMap((e) => (e.kind === kind && 'amountCents' in e && e.amountCents !== null ? [e.amountCents] : []));
  const receipts = amounts('receipt');
  const recharges = amounts('recharge');
  const reports = amounts('merchant_report');

  const expectedCents = currentExpectation(caseRecord, item.id) ?? null;
  const confirmedReceivedCents = sumCents(receipts);
  const rechargedCents = sumCents(recharges);
  const netConfirmedCents = subtractCents(confirmedReceivedCents, rechargedCents);
  const merchantReportedCents = reports.length > 0 ? (reports[reports.length - 1] ?? null) : null;

  const differenceCents = expectedCents === null ? null : subtractCents(expectedCents, netConfirmedCents);
  const unresolvedCents = differenceCents === null ? null : Math.max(0, differenceCents);
  const excessCents = differenceCents === null ? null : Math.max(0, -differenceCents);

  let status: ItemStatus;
  if (differenceCents === null) status = 'expectation_unknown';
  else if (differenceCents === 0) status = 'settled';
  else if (differenceCents < 0) status = 'excess';
  else if (recharges.length > 0) status = 'reopened';
  else if (receipts.length > 0) status = 'partial';
  else if (merchantReportedCents !== null && merchantReportedCents > 0) status = 'issued_unconfirmed';
  else status = 'unconfirmed';

  const flags: ItemFlag[] = [];
  if (merchantReportedCents !== null && merchantReportedCents > netConfirmedCents) {
    flags.push('merchant_reports_more_than_confirmed');
  }
  if (merchantReportedCents !== null && merchantReportedCents < netConfirmedCents) {
    flags.push('merchant_reports_less_than_confirmed');
  }
  if (expectedCents === null && receipts.length > 0) flags.push('receipts_without_expectation');

  return {
    item,
    expectedCents,
    confirmedReceivedCents,
    rechargedCents,
    netConfirmedCents,
    merchantReportedCents,
    differenceCents,
    unresolvedCents,
    excessCents,
    status,
    flags,
  };
}

const REVIEW_STATUSES: readonly ItemStatus[] = ['excess', 'reopened'];

export function summarizeCase(caseRecord: CaseRecord): CaseSummary {
  const items = caseRecord.items.map((item) => summarizeItem(caseRecord, item));
  let unresolvedCents = 0;
  let excessCents = 0;
  let knownExpectedCents = 0;
  let netConfirmedCents = 0;
  for (const s of items) {
    unresolvedCents = addCents(unresolvedCents, s.unresolvedCents ?? 0);
    excessCents = addCents(excessCents, s.excessCents ?? 0);
    knownExpectedCents = addCents(knownExpectedCents, s.expectedCents ?? 0);
    netConfirmedCents = addCents(netConfirmedCents, s.netConfirmedCents);
  }
  const settledCount = items.filter((s) => s.status === 'settled').length;
  const unknownExpectationCount = items.filter((s) => s.status === 'expectation_unknown').length;
  const needsReview = items.some(
    (s) => REVIEW_STATUSES.includes(s.status) || s.flags.includes('merchant_reports_less_than_confirmed'),
  );

  // A case is settled only when every item is settled on its own; one item's
  // excess never covers another item's shortfall.
  const status: CaseStatus =
    items.length > 0 && settledCount === items.length ? 'settled' : needsReview ? 'needs_review' : 'open';

  return {
    status,
    items,
    unresolvedCents,
    excessCents,
    knownExpectedCents,
    netConfirmedCents,
    unknownExpectationCount,
    settledCount,
  };
}

export interface TimelineRow {
  readonly entry: Entry;
  readonly itemLabel: string;
  /** For voided entries, the void that cancelled them. */
  readonly voidedBy: Entry | null;
  /** For expectation entries, the value it replaced (undefined for the first). */
  readonly previousExpectation: Cents | null | undefined;
}

/** All entries in recording order, including voided ones and the voids themselves. */
export function buildTimeline(caseRecord: CaseRecord): readonly TimelineRow[] {
  const labels = new Map(caseRecord.items.map((i) => [i.id, i.label]));
  const voids = new Map(caseRecord.entries.flatMap((e) => (e.kind === 'void' ? [[e.targetEntryId, e] as const] : [])));
  const lastExpectation = new Map<string, Cents | null>();
  return caseRecord.entries.map((entry) => {
    let previousExpectation: Cents | null | undefined;
    if (entry.kind === 'expectation') {
      previousExpectation = lastExpectation.has(entry.itemId) ? lastExpectation.get(entry.itemId) : undefined;
      lastExpectation.set(entry.itemId, entry.amountCents);
    }
    return {
      entry,
      itemLabel: labels.get(entry.itemId) ?? 'Unknown item',
      voidedBy: voids.get(entry.id) ?? null,
      previousExpectation,
    };
  });
}
