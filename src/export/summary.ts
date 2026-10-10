// Pure case-summary text generation. Builds a plain UTF-8 text summary of one
// saved case from the same derivations the dashboard uses (summarizeCase,
// summarizeItem via summarizeCase, buildTimeline). Nothing here reads storage,
// touches the DOM or recomputes stored entries; the output is deterministic for
// a given case, timestamp and option set.

import { formatUsd } from '../domain/money';
import { activeEntries, buildTimeline, summarizeCase, type ItemSummary, type ReviewReason, type TimelineRow } from '../domain/reconcile';
import type { CaseRecord, Entry } from '../domain/types';

export interface CaseSummaryOptions {
  /** When the snapshot behind this summary was read (ISO 8601). */
  readonly generatedAt: string;
  /** Saved-data revision of that snapshot. */
  readonly revision: number;
  /** Opt-in: include free-text notes, transaction/observation references and captured excerpts. */
  readonly includeDetails: boolean;
}

const RETAILER_LABEL: Record<CaseRecord['retailer'], string> = { amazon_us: 'Amazon US' };

const CASE_STATUS_TEXT = {
  settled: 'Settled in these records (every item’s confirmed net received equals its expected refund)',
  needs_review: 'Needs review (at least one item has an active review condition)',
  open: 'Open (expected amounts remain unconfirmed or unknown)',
} as const;

const ITEM_STATUS_TEXT: Record<ItemSummary['status'], string> = {
  expectation_unknown: 'Expected refund unknown',
  unconfirmed: 'No receipt confirmed',
  issued_unconfirmed: 'Merchant reports issued; receipt not confirmed',
  partial: 'Partially confirmed',
  reopened: 'Reopened after a recharge',
  excess: 'More confirmed than expected',
  settled: 'Confirmed net received equals expected refund',
};

const REVIEW_TEXT: Record<ReviewReason, string> = {
  excess: 'More has been confirmed received than expected for this item. The excess is kept with this item for review and does not offset any other item.',
  reopened: 'A recharge was recorded, bringing confirmed net received below the expected refund.',
  merchant_reports_less_than_confirmed:
    'The merchant’s latest issued snapshot is lower than the amount confirmed received. These records conflict; a zero or settled difference does not resolve this.',
};

const KIND_TEXT: Record<Entry['kind'], string> = {
  expectation: 'Expected refund',
  merchant_report: 'Merchant report',
  receipt: 'Receipt confirmed by user',
  recharge: 'Recharge',
  void: 'Void',
};

// Line breaks, other control characters and bidirectional overrides in stored
// text could otherwise forge extra lines or reorder what a reader sees.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

/** Renders stored text on a single line with control characters replaced by spaces. */
export function oneLine(text: string): string {
  return text.replace(UNSAFE_CHARS, ' ');
}

/** "2026-01-05T14:03:09.000Z" -> "2026-01-05 14:03:09 UTC". */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown time';
  const s = d.toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 19)} UTC`;
}

function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? 'Unknown' : formatUsd(cents);
}

function differenceLine(s: ItemSummary): string {
  if (s.differenceCents === null) return 'Difference: Unknown — the expected refund is unknown, so the difference cannot be calculated.';
  if (s.differenceCents > 0) return `Unresolved expected amount: ${formatUsd(s.differenceCents)} (a difference in these records, not a proven amount owed)`;
  if (s.differenceCents < 0) return `Excess over expected: ${formatUsd(-s.differenceCents)} (kept with this item for review; not used to offset any other item)`;
  return 'Difference: $0.00';
}

/** A brief factual explanation of what the records show for one item. */
export function explainItem(s: ItemSummary, activeReportCount: number): string[] {
  const lines: string[] = [];
  const expected = money(s.expectedCents);
  const net = formatUsd(s.netConfirmedCents);
  const noReceipt =
    'The absence of a receipt confirmation here does not establish that no money arrived; it has not been recorded as received.';
  switch (s.status) {
    case 'expectation_unknown':
      lines.push('The expected refund is unknown, so the difference cannot be calculated.');
      if (s.confirmedReceivedCents > 0) {
        lines.push(`Receipts of ${formatUsd(s.confirmedReceivedCents)} have been confirmed, but there is no expected amount to compare them with.`);
      }
      break;
    case 'unconfirmed':
      lines.push(`No receipt has been confirmed for this item against an expected refund of ${expected}.`, noReceipt);
      break;
    case 'issued_unconfirmed':
      lines.push(
        `The merchant’s latest recorded statement reports ${money(s.merchantReportedCents)} issued, but no receipt has been confirmed for this item.`,
        'A merchant statement is not a receipt confirmation.',
        noReceipt,
      );
      break;
    case 'partial':
      lines.push(`${formatUsd(s.confirmedReceivedCents)} has been confirmed received against an expected refund of ${expected}; ${money(s.unresolvedCents)} remains unconfirmed in these records.`);
      break;
    case 'reopened':
      lines.push(
        `Receipts of ${formatUsd(s.confirmedReceivedCents)} were confirmed and recharges of ${formatUsd(s.rechargedCents)} were recorded, so confirmed net received is ${net} against an expected refund of ${expected} (${money(s.unresolvedCents)} difference).`,
      );
      break;
    case 'excess':
      lines.push(
        `Confirmed net received (${net}) exceeds the expected refund (${expected}) by ${money(s.excessCents)}. The excess stays with this item for review and does not settle any other item.`,
      );
      break;
    case 'settled':
      lines.push(`Confirmed net received (${net}) equals the expected refund (${expected}) in these records.`);
      if (s.reviewReasons.length > 0) {
        lines.push('A review condition is still active (see review conditions); the zero difference does not resolve it.');
      }
      break;
  }
  if (s.status !== 'issued_unconfirmed' && s.flags.includes('merchant_reports_more_than_confirmed')) {
    lines.push(
      `The merchant’s latest issued snapshot (${money(s.merchantReportedCents)}) is higher than confirmed net received (${net}). A merchant statement is not a receipt confirmation.`,
    );
  }
  if (s.flags.includes('merchant_reports_less_than_confirmed')) {
    lines.push(`The merchant’s latest issued snapshot (${money(s.merchantReportedCents)}) is lower than confirmed net received (${net}). These records conflict.`);
  }
  if (activeReportCount > 1) {
    lines.push(
      `${activeReportCount} merchant reports are recorded for this item. They are status snapshots and are not added together; only the latest one is used.`,
    );
  }
  return lines;
}

function wrapExcerpt(excerpt: string, indent: string): string[] {
  return excerpt.split(/\r\n|\r|\n/).map((l) => `${indent}| ${oneLine(l)}`);
}

function describeEntry(row: TimelineRow, number: Map<string, number>, caseRecord: CaseRecord): string {
  const e = row.entry;
  switch (e.kind) {
    case 'expectation':
      return row.previousExpectation === undefined
        ? `Expected refund set to ${money(e.amountCents)}`
        : `Expected refund changed from ${money(row.previousExpectation)} to ${money(e.amountCents)}`;
    case 'merchant_report':
      return e.capture
        ? `Merchant statement recorded from selected page text: ${formatUsd(e.amountCents)} issued (status snapshot, not a receipt confirmation)`
        : `Merchant report entered by the user: ${formatUsd(e.amountCents)} issued (status snapshot, not a receipt confirmation)`;
    case 'receipt':
      return `User confirmed ${formatUsd(e.amountCents)} received`;
    case 'recharge':
      return `User recorded a ${formatUsd(e.amountCents)} recharge (money taken back)`;
    case 'void': {
      const target = caseRecord.entries.find((x) => x.id === e.targetEntryId);
      const n = number.get(e.targetEntryId);
      const what = target && 'amountCents' in target ? `${KIND_TEXT[target.kind].toLowerCase()} of ${money(target.amountCents)}` : 'an earlier entry';
      return `Voided entry ${n ?? '?'} (${what}). The voided entry stays in this history but is excluded from current totals.`;
    }
  }
}

/** Builds the shareable plain-text summary for one case. */
export function buildCaseSummaryText(caseRecord: CaseRecord, opts: CaseSummaryOptions): string {
  const summary = summarizeCase(caseRecord);
  const timeline = buildTimeline(caseRecord);
  const active = activeEntries(caseRecord);
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);

  push('REFUND RECORD SUMMARY', '=====================');
  if (caseRecord.isDemo) {
    push('', '*** SYNTHETIC DEMO DATA — made-up example records, not a real order. ***');
  }
  push(
    '',
    `Retailer: ${RETAILER_LABEL[caseRecord.retailer]}`,
    `Order reference: ${caseRecord.orderRef === null ? 'Not recorded' : oneLine(caseRecord.orderRef)}`,
    `Currency: ${caseRecord.currency}`,
    `Generated: ${formatUtc(opts.generatedAt)} from saved data in this browser (revision ${opts.revision})`,
    opts.includeDetails
      ? 'Evidence details: included (notes, transaction/observation references and captured excerpts)'
      : 'Evidence details: omitted (notes, transaction/observation references and captured excerpts are left out; entries that have them are marked)',
    '',
    'About this summary',
    '- Prepared by the account holder from their own records in Refund Reconciler, a local browser extension. It is not issued, verified or endorsed by Amazon, and the amounts have not been verified against any bank or card statement.',
    '- “Confirmed received” means the account holder recorded that the money arrived. Merchant reports are statements made by the merchant (status snapshots); they are not receipt confirmations.',
    '- An unresolved expected amount is a difference in these records, not a proven amount owed. Each item is reconciled on its own; an excess on one item never offsets another item.',
    '',
    'CASE OVERVIEW',
    '-------------',
    `Status in these records: ${CASE_STATUS_TEXT[summary.status]}`,
    `Items: ${summary.items.length}`,
    `Unresolved expected amount (sum of per-item shortfalls with a known expectation): ${formatUsd(summary.unresolvedCents)}`,
    `Excess recorded (per item, not offset against other items): ${formatUsd(summary.excessCents)}`,
    `Items with an unknown expected refund: ${summary.unknownExpectationCount}`,
    '',
    'ITEMS',
    '-----',
  );

  summary.items.forEach((s, i) => {
    const reportCount = active.filter((e) => e.kind === 'merchant_report' && e.itemId === s.item.id).length;
    push(
      `Item ${i + 1}: ${oneLine(s.item.label)}`,
      `  Status: ${ITEM_STATUS_TEXT[s.status]}${s.reviewReasons.length > 0 ? ' — needs review' : ''}`,
      `  Current expected refund: ${money(s.expectedCents)}`,
      `  Latest active merchant-issued snapshot: ${s.merchantReportedCents === null ? 'None recorded' : `${formatUsd(s.merchantReportedCents)} (merchant statement, not a receipt confirmation)`}`,
      `  Receipts confirmed by user: ${formatUsd(s.confirmedReceivedCents)}`,
      `  Recharges recorded: ${formatUsd(s.rechargedCents)}`,
      `  Confirmed net received: ${formatUsd(s.netConfirmedCents)}`,
      `  ${differenceLine(s)}`,
    );
    if (s.reviewReasons.length > 0) {
      push('  Review conditions:', ...s.reviewReasons.map((r) => `    - ${REVIEW_TEXT[r]}`));
    } else {
      push('  Review conditions: none');
    }
    push('  What the records show:', ...explainItem(s, reportCount).map((l) => `    ${l}`), '');
  });

  push(
    'CHRONOLOGY',
    '----------',
    'Entries are listed in the order they were recorded in the extension, not sorted by event date.',
    '“Recorded” is when the entry was saved. “Occurred” is an optional date the account holder entered or the merchant showed; “not given” means it is unknown.',
    'Expected-refund changes are kept as history; the latest one is the current expected refund.',
    '',
  );
  const number = new Map(timeline.map((row, i) => [row.entry.id, i + 1]));
  timeline.forEach((row, i) => {
    const e = row.entry;
    const voidedNote = row.voidedBy ? ` [VOIDED by entry ${number.get(row.voidedBy.id) ?? '?'} — kept as history, excluded from current totals]` : '';
    push(
      `${i + 1}. ${KIND_TEXT[e.kind]}${voidedNote}`,
      `   Item: ${oneLine(row.itemLabel)}`,
      `   Recorded: ${formatUtc(e.recordedAt)} · Occurred: ${e.occurredOn ?? 'not given'}`,
      `   ${describeEntry(row, number, caseRecord)}`,
      `   Source: ${oneLine(e.source)}`,
    );
    if (e.kind === 'merchant_report' && e.capture) {
      const c = e.capture;
      push(
        `   Captured: ${formatUtc(c.capturedAt)} from ${c.sourceOrigin}${c.sourcePath === null ? '' : oneLine(c.sourcePath)} · parser version ${oneLine(c.parserVersion)} · approved amount text “${oneLine(c.approvedAmountText)}”`,
      );
      if (c.detectedOrderRef !== null) push(`   Order number in selected text: ${oneLine(c.detectedOrderRef)}`);
      if (opts.includeDetails) push('   Captured excerpt:', ...wrapExcerpt(c.excerpt, '     '));
      else push('   Captured excerpt: [omitted]');
    }
    if ('reference' in e && e.reference !== null) {
      push(opts.includeDetails ? `   Reference: ${oneLine(e.reference)}` : '   Reference: [omitted]');
    }
    if (e.note !== '') {
      const label = e.kind === 'void' ? 'Void reason' : 'Note';
      push(opts.includeDetails ? `   ${label}: ${oneLine(e.note)}` : `   ${label}: [omitted]`);
    }
    push('');
  });

  push('End of summary.');
  return `${out.join('\n')}\n`;
}
