import { formatUsd } from '../domain/money';
import type { CaseStatus, ItemFlag, ItemStatus, ReviewReason } from '../domain/reconcile';
import type { Entry } from '../domain/types';

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  expectation_unknown: 'Expected amount unknown',
  unconfirmed: 'Funds unconfirmed',
  issued_unconfirmed: 'Merchant reports issued · receipt unconfirmed',
  partial: 'Partially confirmed',
  reopened: 'Reopened · recharge recorded',
  excess: 'More confirmed than expected · review',
  settled: 'Settled · confirmed received',
};

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  settled: 'Settled',
  needs_review: 'Needs review',
  open: 'Open',
};

export const FLAG_LABEL: Record<ItemFlag, string> = {
  merchant_reports_more_than_confirmed: 'Merchant reports more issued than you have confirmed received.',
  merchant_reports_less_than_confirmed: 'Merchant reports less issued than you have confirmed received.',
  receipts_without_expectation: 'Receipts recorded but the expected amount is unknown, so nothing can be compared.',
};

export const KIND_LABEL: Record<Entry['kind'], string> = {
  expectation: 'Expected refund',
  merchant_report: 'Merchant report',
  receipt: 'Money received (confirmed)',
  recharge: 'Recharge',
  void: 'Void',
};

export function moneyOrUnknown(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? 'Unknown' : formatUsd(cents);
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  excess: 'More has been confirmed received than expected. It is kept for review and does not offset any other item.',
  reopened: 'A recharge brought confirmed net receipts below the expected amount.',
  merchant_reports_less_than_confirmed:
    'The merchant’s latest issued total is lower than the amount you confirmed receiving. Your confirmed receipts are unchanged; check which record is right and void any mistaken entry.',
};

export const REVIEW_REASON_SHORT: Record<ReviewReason, string> = {
  excess: 'more received than expected',
  reopened: 'recharge recorded',
  merchant_reports_less_than_confirmed: 'merchant report conflicts with confirmed receipts',
};
