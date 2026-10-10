// Read-only dashboard overview and case finding. Every figure comes from
// summarizeCase; nothing here re-derives financial rules, writes storage or
// reorders stored cases. Synthetic demo cases are always excluded.

import { addCents, type Cents } from './money';
import { summarizeCase, type CaseStatus, type CaseSummary } from './reconcile';
import type { CaseRecord } from './types';

/** One real case with its derived summary, computed once per render. */
export interface CaseView {
  readonly record: CaseRecord;
  readonly summary: CaseSummary;
}

export type StatusFilter = 'all' | 'attention' | 'review' | 'settled';

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'attention', 'review', 'settled'];

/** Longest search query used; longer input is cut here and by the input's maxlength. */
export const QUERY_MAX = 200;

export interface Overview {
  /** Real (non-demo) cases the totals cover. */
  readonly caseCount: number;
  /**
   * Sum of every real case's unresolvedCents (known expectations only), or
   * unavailable when the cross-case sum cannot be represented exactly.
   */
  readonly unresolved: { readonly ok: true; readonly cents: Cents } | { readonly ok: false };
  /** Items whose expected amount is unknown. Never folded into the total. */
  readonly unknownItemCount: number;
  /** Cases whose status is not settled. */
  readonly attentionCount: number;
  /** Cases whose status is needs_review. */
  readonly reviewCount: number;
}

/** Real cases with their summaries, in storage order. Demo cases are dropped. */
export function realCaseViews(cases: readonly CaseRecord[]): CaseView[] {
  return cases.filter((c) => !c.isDemo).map((record) => ({ record, summary: summarizeCase(record) }));
}

export function buildOverview(views: readonly CaseView[]): Overview {
  const real = views.filter((v) => !v.record.isDemo);
  let unresolved: Overview['unresolved'] = { ok: true, cents: 0 };
  for (const v of real) {
    if (!unresolved.ok) break;
    try {
      unresolved = { ok: true, cents: addCents(unresolved.cents, v.summary.unresolvedCents) };
    } catch {
      unresolved = { ok: false };
    }
  }
  return {
    caseCount: real.length,
    unresolved,
    unknownItemCount: real.reduce((n, v) => n + v.summary.unknownExpectationCount, 0),
    attentionCount: real.filter((v) => statusMatches(v.summary.status, 'attention')).length,
    reviewCount: real.filter((v) => statusMatches(v.summary.status, 'review')).length,
  };
}

export function statusMatches(status: CaseStatus, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'attention':
      return status !== 'settled';
    case 'review':
      return status === 'needs_review';
    case 'settled':
      return status === 'settled';
  }
}

/** Bounded, trimmed, lower-cased search text. Empty means no search restriction. */
export function normalizeQuery(raw: string): string {
  return raw.slice(0, QUERY_MAX).trim().toLowerCase();
}

/**
 * Literal, case-insensitive substring match on the order reference and item
 * descriptions only. Notes, references and captured excerpts are not searched.
 */
export function caseMatchesQuery(record: CaseRecord, normalizedQuery: string): boolean {
  if (normalizedQuery === '') return true;
  const fields = [record.orderRef ?? '', ...record.items.map((i) => i.label)];
  return fields.some((f) => f.toLowerCase().includes(normalizedQuery));
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Most recently updated first; equal times are ordered by id so the order never depends on storage position. */
export function compareForDisplay(a: CaseRecord, b: CaseRecord): number {
  const dt = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  if (dt !== 0 && !Number.isNaN(dt)) return dt > 0 ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Matching real cases in display order. Returns a new array; the input is not reordered. */
export function findCases(views: readonly CaseView[], filter: { query: string; status: StatusFilter }): CaseView[] {
  const q = normalizeQuery(filter.query);
  return views
    .filter((v) => !v.record.isDemo && statusMatches(v.summary.status, filter.status) && caseMatchesQuery(v.record, q))
    .sort((a, b) => compareForDisplay(a.record, b.record));
}
