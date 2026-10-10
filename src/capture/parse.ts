// Deterministic interpretation of a user-selected excerpt of an Amazon US page.
// Pure: no DOM, no storage, no network, no heuristics beyond the documented
// patterns below. The excerpt is untrusted page text.
//
// Supported patterns (synthetic parser contracts, NOT proof of current Amazon
// wording; see docs/capture.md):
//   - "Refund issued: $70.00" / "Refund issued $70.00" / "Refund issued for $70.00"
//   - "Refunded: $70.00" / "Amount refunded: $70.00" / "$70.00 refunded"
//   - "Your refund of $70.00 has been issued" / "We've issued a refund of $70.00"
//   - A label line followed by value lines: "Refund issued" / [date] / "$70.00"
//   - An optional "Month D, YYYY" date inside the issued statement
//   - An Amazon order ID (123-1234567-1234567 or D01-1234567-1234567) anywhere
// An amount is only "issued" when its statement uses issued/refunded wording,
// has no pending/expected/price/charge wording, and contains exactly one
// dollar amount. Multiple issued statements, order-level totals, unsupported
// currencies and malformed amounts are never resolved by guessing.

import { parseMoney, type Cents } from '../domain/money';
import { isValidCalendarDate } from '../domain/validate';

export const PARSER_VERSION = 'amazon-us-selection-1';
export const EXCERPT_MAX_CHARS = 4000;

export type NotIssuedReason = 'recharge' | 'pending' | 'expected' | 'purchase_price' | 'return_received' | 'unlabelled';

export type UnsupportedReason =
  | 'empty'
  | 'too_long'
  | 'unsupported_currency'
  | 'malformed_amount'
  | 'zero_amount'
  | 'no_issued_amount'
  | 'multiple_issued_amounts'
  | 'conflicting_wording'
  | 'aggregate_order_total'
  | 'multiple_order_refs';

export type DateResult =
  | { status: 'found'; value: string }
  | { status: 'none' }
  /** Dates were present but not a single valid one in the issued statement. */
  | { status: 'unknown'; reason: 'multiple' | 'invalid' | 'outside_statement' };

export interface ExcerptAnalysis {
  readonly parserVersion: typeof PARSER_VERSION;
  /** The normalised text that was analysed and would be stored if approved. */
  readonly excerpt: string;
  /** The issued amount proposed for approval, or null if there is none. */
  readonly issued: { readonly cents: Cents; readonly amountText: string; readonly statement: string } | null;
  readonly orderRef: { status: 'found'; value: string } | { status: 'none' } | { status: 'ambiguous'; values: readonly string[] };
  readonly date: DateResult;
  /** Dollar amounts seen but deliberately not treated as issued. */
  readonly notIssued: readonly { readonly amountText: string; readonly reason: NotIssuedReason }[];
  /** Why no proposal can be made. Empty when `issued` is set. */
  readonly problems: readonly UnsupportedReason[];
}

/**
 * Normalises whitespace and removes invisible/bidirectional control characters
 * that could hide or reorder words. Visible text is otherwise kept verbatim.
 */
export function normalizeExcerpt(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u00A0\u2007\u202F\t\f\v]/g, ' ')
    // eslint-disable-next-line no-control-regex -- deliberately strips control characters
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}

const FOREIGN_CURRENCY =
  /(?:\b(?:CA|C|A|AU|NZ|MX|HK|S|R|NT|CDN)\$)|[€£¥₹₩₽₺₱₪]|\b(?:EUR|GBP|CAD|AUD|JPY|MXN|INR|CNY|BRL|CHF|SEK|NZD|SGD|HKD)\b/;
// A "$" amount. The sign group catches "$-70" / "-$70"; the digits group is
// handed to the strict cent parser, so "$70.005" or "$7,0.00" are rejected.
const DOLLAR_AMOUNT = /(?<![A-Za-z0-9])([-−+]\s?)?(?:US)?\$\s?([-−+]?)([0-9][0-9,.]*[0-9]|[0-9])(?![0-9])/g;

const ISSUED_WORDING = (s: string) => /\brefunded\b/i.test(s) || (/\brefund\b/i.test(s) && /\bissued\b/i.test(s));
const DISQUALIFIER =
  /\b(?:pending|expected|expect|estimated?|est\.|will|would|should|may|might|could|scheduled|processing|in progress|initiated|requested|request|eligible|up to|not|never|cancell?ed|denied|declined|reversed|to be|awaiting|price|paid|cost|subtotal|re-?charged?|charge|charged|fee|deducted|deduction)\b|n['’]t\b/i;
// Order-level refund wording anywhere in the excerpt means the issued amount
// may cover several items. Inside an issued statement, purchase-total wording
// and item counts mean the same.
const AGGREGATE_REFUND =
  /\b(?:refund total|total refund(?:ed)?|refund summary|for (?:this|your|the) order|order refund|entire order|all items)\b/i;
const AGGREGATE_STATEMENT = new RegExp(`${AGGREGATE_REFUND.source}|\\b(?:order total|grand total|order summary|\\d+ items)\\b`, 'i');

const MONTH = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE = new RegExp(`\\b${MONTH}\\.? (\\d{1,2}),? (\\d{4})\\b`, 'gi');
const DATE_ONLY = new RegExp(`^(?:on )?${MONTH}\\.? \\d{1,2},? \\d{4}[.:]?$`, 'i');
const AMOUNT_ONLY = /^(?:US)?\$\s?[0-9][0-9,.]*(?: USD)?[.]?$/;
const ORDER_REF = /(?<![A-Za-z0-9-])(?:\d{3}|D\d{2})-\d{7}-\d{7}(?![0-9-])/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

interface Amount {
  readonly text: string;
  readonly cents: Cents | null;
  readonly bad: 'malformed' | 'zero' | null;
}

function amountsIn(segment: string): Amount[] {
  const out: Amount[] = [];
  for (const m of segment.matchAll(DOLLAR_AMOUNT)) {
    const signed = (m[1] ?? '') !== '' || (m[2] ?? '') !== '';
    const digits = m[3] ?? '';
    const parsed = parseMoney(digits);
    const text = m[0].trim();
    if (signed || !parsed.ok) out.push({ text, cents: null, bad: 'malformed' });
    else if (parsed.cents === 0) out.push({ text, cents: 0, bad: 'zero' });
    else out.push({ text, cents: parsed.cents, bad: null });
  }
  return out;
}

/** Splits into statements: lines, then sentences; joins "label" lines with their value lines. */
function statements(text: string): string[] {
  const pieces = text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    let current = pieces[i] ?? '';
    if (ISSUED_WORDING(current) && amountsIn(current).length === 0) {
      // "Refund issued" followed by optional date lines and one amount line.
      let j = i + 1;
      const joined = [current];
      while (j < pieces.length && DATE_ONLY.test(pieces[j] ?? '')) joined.push(pieces[j++] ?? '');
      if (j < pieces.length && AMOUNT_ONLY.test(pieces[j] ?? '')) {
        joined.push(pieces[j] ?? '');
        current = joined.join(' ');
        i = j;
      }
    }
    out.push(current);
  }
  return out;
}

function classifyNotIssued(statement: string): NotIssuedReason {
  if (/\b(?:re-?charged?|charged?|deducted|deduction|fee|reversed)\b/i.test(statement)) return 'recharge';
  if (/\b(?:pending|processing|in progress|initiated|requested|awaiting)\b/i.test(statement)) return 'pending';
  if (/\b(?:expected|expect|estimated?|est\.|will|should|may|up to|eligible|to be)\b/i.test(statement)) return 'expected';
  if (/\b(?:price|paid|cost|subtotal|total|purchase)\b/i.test(statement)) return 'purchase_price';
  if (/\breturn(?:ed)? received\b|\breceived your (?:return|item)\b/i.test(statement)) return 'return_received';
  return 'unlabelled';
}

function findDate(statement: string): DateResult {
  const found = new Set<string>();
  let invalid = false;
  for (const m of statement.matchAll(DATE)) {
    const month = MONTHS.indexOf((m[1] ?? '').slice(0, 3).toLowerCase()) + 1;
    const iso = `${m[3]}-${String(month).padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}`;
    if (month > 0 && isValidCalendarDate(iso)) found.add(iso);
    else invalid = true;
  }
  if (found.size > 1) return { status: 'unknown', reason: 'multiple' };
  if (found.size === 1 && !invalid) return { status: 'found', value: [...found][0] ?? '' };
  if (invalid || found.size === 1) return { status: 'unknown', reason: 'invalid' };
  return { status: 'none' };
}

export function analyzeExcerpt(raw: string): ExcerptAnalysis {
  const excerpt = normalizeExcerpt(raw);
  const base = { parserVersion: PARSER_VERSION, excerpt } as const;
  const problems: UnsupportedReason[] = [];
  const notIssued: { amountText: string; reason: NotIssuedReason }[] = [];

  if (excerpt === '') return { ...base, issued: null, orderRef: { status: 'none' }, date: { status: 'none' }, notIssued, problems: ['empty'] };
  if (raw.length > EXCERPT_MAX_CHARS || excerpt.length > EXCERPT_MAX_CHARS) {
    return { ...base, excerpt: '', issued: null, orderRef: { status: 'none' }, date: { status: 'none' }, notIssued, problems: ['too_long'] };
  }

  const refs = [...new Set([...excerpt.matchAll(ORDER_REF)].map((m) => m[0].toUpperCase()))];
  const orderRef: ExcerptAnalysis['orderRef'] =
    refs.length === 0 ? { status: 'none' } : refs.length === 1 ? { status: 'found', value: refs[0] ?? '' } : { status: 'ambiguous', values: refs };
  if (refs.length > 1) problems.push('multiple_order_refs');
  if (FOREIGN_CURRENCY.test(excerpt)) problems.push('unsupported_currency');

  const candidates: { statement: string; amount: Amount }[] = [];
  let conflicting = false;
  let aggregate = AGGREGATE_REFUND.test(excerpt);
  for (const statement of statements(excerpt)) {
    const amounts = amountsIn(statement);
    if (amounts.some((a) => a.bad === 'malformed')) problems.push('malformed_amount');
    // Dates are removed before wording checks so "May 3" is not read as "may".
    const words = statement.replace(DATE, ' ');
    const issuedWording = ISSUED_WORDING(words);
    const disqualified = DISQUALIFIER.test(words);
    if (issuedWording && disqualified && amounts.length > 0) conflicting = true;
    if (issuedWording && AGGREGATE_STATEMENT.test(words)) aggregate = true;
    const usable = issuedWording && !disqualified && amounts.length === 1;
    if (usable && amounts[0]) {
      candidates.push({ statement, amount: amounts[0] });
    } else {
      if (issuedWording && amounts.length > 1) conflicting = true;
      for (const a of amounts) notIssued.push({ amountText: a.text, reason: classifyNotIssued(words) });
    }
  }

  if (aggregate) problems.push('aggregate_order_total');
  if (candidates.length > 1) problems.push('multiple_issued_amounts');
  else if (conflicting) problems.push('conflicting_wording');
  else if (candidates.length === 0) problems.push('no_issued_amount');
  if (candidates.length === 1 && candidates[0]?.amount.bad === 'zero') problems.push('zero_amount');

  const unique = [...new Set(problems)];
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (unique.length > 0 || !only || only.amount.cents === null) {
    for (const c of candidates) notIssued.push({ amountText: c.amount.text, reason: 'unlabelled' });
    return { ...base, issued: null, orderRef, date: only ? findDate(only.statement) : { status: 'none' }, notIssued, problems: unique };
  }
  const date = findDate(only.statement);
  const anyDate = [...excerpt.matchAll(DATE)].length > 0;
  return {
    ...base,
    issued: { cents: only.amount.cents, amountText: only.amount.text, statement: only.statement },
    orderRef,
    date: date.status === 'none' && anyDate ? { status: 'unknown', reason: 'outside_statement' } : date,
    notIssued,
    problems: [],
  };
}

/** Extracts a recognisable Amazon order ID from free text such as a case's order reference. */
export function extractOrderId(text: string | null): string | null {
  if (text === null) return null;
  const ids = [...new Set([...text.matchAll(ORDER_REF)].map((m) => m[0].toUpperCase()))];
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

export type OrderCompatibility = 'match' | 'mismatch' | 'case_has_no_order' | 'excerpt_has_no_order' | 'not_comparable';

/** Compares the excerpt's order ID with a case's order reference. Never matches by amount or label. */
export function compareOrder(detected: string | null, caseOrderRef: string | null): OrderCompatibility {
  if (detected === null) return 'excerpt_has_no_order';
  if (caseOrderRef === null || caseOrderRef.trim() === '') return 'case_has_no_order';
  const caseId = extractOrderId(caseOrderRef);
  if (caseId === null) return 'not_comparable';
  return caseId === detected.toUpperCase() ? 'match' : 'mismatch';
}
