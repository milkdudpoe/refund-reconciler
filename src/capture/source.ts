// Pure checks on the page a capture reads from. Only HTTPS pages whose parsed
// hostname is exactly amazon.com or www.amazon.com are supported; everything
// else (lookalike hosts, other Amazon country sites, other schemes, browser
// pages) is rejected. Used before injection and again on the URL the injected
// collector reports, so a navigation in between is caught.

import type { CaptureOrigin } from '../domain/types';

export const SUPPORTED_ORIGINS: readonly CaptureOrigin[] = ['https://www.amazon.com', 'https://amazon.com'];

export type SourceProblem =
  /** No URL is visible: the extension has no access to this tab. */
  | 'no_access'
  /** chrome://, chrome-extension://, the Web Store and similar pages. */
  | 'restricted'
  /** A non-HTTPS page (http:, file:, data:, …). */
  | 'unsupported_scheme'
  /** HTTPS, but not exactly amazon.com / www.amazon.com. */
  | 'unsupported_host';

export type SourceCheck =
  | { ok: true; origin: CaptureOrigin }
  | { ok: false; problem: SourceProblem };

const RESTRICTED_SCHEMES = ['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'devtools:', 'edge:', 'about:', 'view-source:', 'chrome-search:'];
const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

export function checkSourceUrl(url: string | undefined | null): SourceCheck {
  if (url === undefined || url === null || url === '') return { ok: false, problem: 'no_access' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, problem: 'restricted' };
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return { ok: false, problem: 'restricted' };
  if (parsed.protocol !== 'https:') return { ok: false, problem: 'unsupported_scheme' };
  if (RESTRICTED_HOSTS.includes(parsed.hostname)) return { ok: false, problem: 'restricted' };
  // URL() lower-cases the host and strips a default :443. Any explicit port,
  // credentials or trailing-dot host is treated as unsupported.
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return { ok: false, problem: 'unsupported_host' };
  const origin = `https://${parsed.hostname}`;
  if (!(SUPPORTED_ORIGINS as readonly string[]).includes(origin)) return { ok: false, problem: 'unsupported_host' };
  return { ok: true, origin: origin as CaptureOrigin };
}

export const SOURCE_PATH_MAX = 300;
const ORDER_ID_PATTERN = /^(?:\d{3}|D\d{2})-\d{7}-\d{7}$/;
const SAFE_PATH = /^\/[A-Za-z0-9/_.~%-]*$/;

/**
 * Reduces a page URL to the minimum needed to explain a capture later: the
 * path without "ref=" tracking segments, plus an order ID query parameter if
 * it is a well-formed Amazon order ID. Fragments and every other query
 * parameter (tracking, session, authentication) are dropped. Returns null if
 * the remaining path is unusual or too long to keep safely.
 */
export function sanitizeSourcePath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '' && !/^ref=/i.test(s));
  let path = `/${segments.join('/')}`;
  if (!SAFE_PATH.test(path)) return null;
  const orderId = parsed.searchParams.get('orderID') ?? parsed.searchParams.get('orderId');
  if (orderId !== null && ORDER_ID_PATTERN.test(orderId)) path += `?orderID=${orderId}`;
  return path.length <= SOURCE_PATH_MAX ? path : null;
}

/** Runtime check used when stored or messaged provenance is validated. */
export function isValidSourcePath(v: string): boolean {
  if (v.length > SOURCE_PATH_MAX) return false;
  const [path, query, ...rest] = v.split('?');
  if (rest.length > 0 || path === undefined || !SAFE_PATH.test(path)) return false;
  if (query === undefined) return true;
  const m = /^orderID=(.+)$/.exec(query);
  return m !== null && ORDER_ID_PATTERN.test(m[1] ?? '');
}
