// Order-number context for a capture, and the single compatibility rule used
// by both the popup and the service worker. Pure. Order IDs are only ever
// compared with each other: nothing is matched by amount or item title, no
// case is chosen automatically, and a missing ID stays unknown.

/** An Amazon order ID: 123-1234567-1234567 or D01-1234567-1234567 (digital). */
export const ORDER_ID_PATTERN = /^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/i;
/** Finds order IDs inside free text. */
export const ORDER_ID_IN_TEXT = /(?<![A-Za-z0-9-])(?:\d{3}|D\d{2})-\d{7}-\d{7}(?![0-9-])/gi;

/** Order context from one source (the selected text, or the page URL). */
export type OrderContext =
  | { readonly status: 'found'; readonly value: string }
  | { readonly status: 'none' }
  | { readonly status: 'ambiguous'; readonly values: readonly string[] };

export function orderContextOf(ids: readonly string[]): OrderContext {
  const distinct = [...new Set(ids.map((id) => id.toUpperCase()))];
  if (distinct.length === 0) return { status: 'none' };
  if (distinct.length === 1) return { status: 'found', value: distinct[0] ?? '' };
  return { status: 'ambiguous', values: distinct };
}

export function orderIdsInText(text: string): string[] {
  return [...text.matchAll(ORDER_ID_IN_TEXT)].map((m) => m[0]);
}

/** A single recognisable order ID in free text such as a case's order reference, else null. */
export function extractOrderId(text: string | null): string | null {
  if (text === null) return null;
  const ctx = orderContextOf(orderIdsInText(text));
  return ctx.status === 'found' ? ctx.value : null;
}

export type OrderBlock =
  /** The page URL names more than one order. */
  | 'source_ambiguous'
  /** The selected text names more than one order. */
  | 'excerpt_ambiguous'
  /** The page URL and the selected text name different orders. */
  | 'source_excerpt_conflict'
  /** The capture's known order differs from the chosen case's order. */
  | 'case_mismatch';

export type CaseOrderCheck =
  /** No case chosen yet. */
  | 'no_case'
  | 'match'
  /** Neither the URL nor the selection names an order, so nothing could be compared. */
  | 'capture_has_no_order'
  /** The case has no order reference. */
  | 'case_has_no_order'
  /** The case's order reference has no single recognisable order ID. */
  | 'not_comparable';

export type OrderAssessment =
  | { readonly ok: true; readonly knownOrder: string | null; readonly caseCheck: CaseOrderCheck }
  | { readonly ok: false; readonly block: OrderBlock; readonly knownOrder: string | null };

/**
 * The one order-compatibility rule. `caseOrderRef` is undefined when no case
 * has been chosen (checks the capture on its own). Contradictions are never
 * resolved by picking one side.
 */
export function assessOrder(excerpt: OrderContext, source: OrderContext, caseOrderRef?: string | null): OrderAssessment {
  if (source.status === 'ambiguous') return { ok: false, block: 'source_ambiguous', knownOrder: null };
  if (excerpt.status === 'ambiguous') return { ok: false, block: 'excerpt_ambiguous', knownOrder: null };
  if (source.status === 'found' && excerpt.status === 'found' && source.value !== excerpt.value) {
    return { ok: false, block: 'source_excerpt_conflict', knownOrder: null };
  }
  const knownOrder = excerpt.status === 'found' ? excerpt.value : source.status === 'found' ? source.value : null;
  if (caseOrderRef === undefined) return { ok: true, knownOrder, caseCheck: 'no_case' };
  if (knownOrder === null) return { ok: true, knownOrder, caseCheck: 'capture_has_no_order' };
  if (caseOrderRef === null || caseOrderRef.trim() === '') return { ok: true, knownOrder, caseCheck: 'case_has_no_order' };
  const caseId = extractOrderId(caseOrderRef);
  if (caseId === null) return { ok: true, knownOrder, caseCheck: 'not_comparable' };
  return caseId === knownOrder ? { ok: true, knownOrder, caseCheck: 'match' } : { ok: false, block: 'case_mismatch', knownOrder };
}
