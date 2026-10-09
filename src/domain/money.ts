// Money is always held as a safe integer number of cents. No floating-point
// dollar arithmetic happens anywhere in the app.

export type Cents = number;

export type MoneyParseError =
  | 'empty'
  | 'malformed'
  | 'negative'
  | 'too_precise'
  | 'too_large';

export type MoneyParseResult =
  | { ok: true; cents: Cents }
  | { ok: false; error: MoneyParseError };

/** Largest amount accepted from user input: $1,000,000,000.00. */
export const MAX_INPUT_CENTS = 100_000_000_000;

const MONEY_PATTERN = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * Strictly parses a user-entered USD amount such as "35", "35.5", "$1,234.56".
 * Rejects signs, exponents, more than two decimal places, stray characters,
 * and anything above MAX_INPUT_CENTS. Parsing is done on digit strings with
 * BigInt so no value ever passes through a float.
 */
export function parseMoney(input: string): MoneyParseResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'empty' };
  if (/^[-−(]|^\$\s*-/.test(trimmed)) return { ok: false, error: 'negative' };
  const match = MONEY_PATTERN.exec(trimmed);
  if (!match) return { ok: false, error: 'malformed' };
  const whole = (match[1] ?? '').replaceAll(',', '');
  const fraction = match[2];
  if (fraction !== undefined && fraction.length > 2) return { ok: false, error: 'too_precise' };
  if (fraction !== undefined && fraction.length === 0) return { ok: false, error: 'malformed' };
  const cents = BigInt(whole) * 100n + BigInt((fraction ?? '').padEnd(2, '0'));
  if (cents > BigInt(MAX_INPUT_CENTS)) return { ok: false, error: 'too_large' };
  return { ok: true, cents: Number(cents) };
}

export function moneyErrorMessage(error: MoneyParseError): string {
  switch (error) {
    case 'empty':
      return 'Enter an amount.';
    case 'malformed':
      return 'Enter a USD amount like 35 or 35.00.';
    case 'negative':
      return 'Amounts cannot be negative.';
    case 'too_precise':
      return 'Use at most two decimal places.';
    case 'too_large':
      return 'Amount is too large.';
  }
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Adds cents, refusing to produce an unsafe integer. */
export function addCents(a: Cents, b: Cents): Cents {
  const sum = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(sum)) {
    throw new RangeError('Monetary sum exceeds safe integer range');
  }
  return sum;
}

export function subtractCents(a: Cents, b: Cents): number {
  const diff = a - b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(diff)) {
    throw new RangeError('Monetary difference exceeds safe integer range');
  }
  return diff;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => addCents(acc, v), 0);
}

/** Formats integer cents as USD, e.g. 123456 -> "$1,234.56", -2000 -> "−$20.00". */
export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('Not a safe integer cent amount');
  const negative = cents < 0;
  const abs = BigInt(Math.abs(cents));
  const dollars = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rem = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '−' : ''}$${dollars}.${rem}`;
}

/** Renders cents back into an editable input string, e.g. 3500 -> "35.00". */
export function centsToInput(cents: Cents): string {
  return formatUsd(cents).replace('$', '').replaceAll(',', '');
}
