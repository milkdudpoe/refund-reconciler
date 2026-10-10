// Passphrase rules, shared by the pages (for immediate feedback) and the
// service worker (which enforces them). The phrase is used exactly as typed:
// it is never trimmed, case-folded, Unicode-normalised or truncated. Its
// UTF-8 encoding is what the key derivation receives.

/** At least this many Unicode code points (not UTF-16 units, not bytes). */
export const PASSPHRASE_MIN_CODE_POINTS = 12;
/** At most this many bytes once UTF-8 encoded (about 1,000 ASCII characters). */
export const PASSPHRASE_MAX_BYTES = 1024;

export type PassphraseProblem = 'not_text' | 'too_short' | 'too_long' | 'malformed';

export type PassphraseCheck = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: PassphraseProblem };

/** A lone UTF-16 surrogate cannot be encoded as UTF-8; TextEncoder would silently replace it, so it is refused instead. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function checkPassphrase(v: unknown): PassphraseCheck {
  if (typeof v !== 'string') return { ok: false, problem: 'not_text' };
  // Cheap bound before any per-character work: each UTF-16 unit is at least one UTF-8 byte.
  if (v.length > PASSPHRASE_MAX_BYTES) return { ok: false, problem: 'too_long' };
  if (LONE_SURROGATE.test(v)) return { ok: false, problem: 'malformed' };
  if ([...v].length < PASSPHRASE_MIN_CODE_POINTS) return { ok: false, problem: 'too_short' };
  const bytes = new TextEncoder().encode(v);
  if (bytes.length > PASSPHRASE_MAX_BYTES) return { ok: false, problem: 'too_long' };
  return { ok: true, bytes };
}

export const PASSPHRASE_PROBLEM_MESSAGE: Record<PassphraseProblem, string> = {
  not_text: 'Enter a passphrase.',
  too_short: `Use at least ${PASSPHRASE_MIN_CODE_POINTS} characters. A few unrelated words that only you would pick work well.`,
  too_long: `That passphrase is too long (the limit is ${PASSPHRASE_MAX_BYTES} bytes of text, about ${PASSPHRASE_MAX_BYTES} plain letters).`,
  malformed: 'That passphrase contains a character that cannot be stored as text. Retype it rather than pasting it.',
};
