// Pure checks on the page a capture reads from. Only HTTPS pages whose parsed
// hostname is exactly amazon.com or www.amazon.com are supported; everything
// else (lookalike hosts, other Amazon country sites, other schemes, browser
// pages) is rejected. Used before injection and again on the URL the injected
// collector reports, so a navigation in between is caught.

import type { CaptureOrigin } from '../domain/types';
import { ORDER_ID_PATTERN, orderContextOf, type OrderContext } from './order';

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
const SAFE_PATH = /^\/[A-Za-z0-9/_.~%-]*$/;

const ORDER_QUERY_KEYS = ['orderID', 'orderId'];

function orderIdsInPathSegments(path: string): string[] {
  return path.split('/').filter((seg) => ORDER_ID_PATTERN.test(seg));
}

export interface SourceAnalysis {
  /** Sanitised path to store as provenance, or null if not kept. */
  readonly path: string | null;
  /** Order context named by the URL itself (query orderID/orderId values and order-ID path segments). */
  readonly order: OrderContext;
}

/**
 * Reduces a page URL to the minimum needed to explain a capture later and
 * reads its order context. The path keeps everything except "ref=" tracking
 * segments; the query keeps only `orderID=<id>` when the URL names exactly one
 * order. Every other query parameter (tracking, session, authentication) and
 * the fragment are dropped. Several different order IDs are ambiguous: none is
 * kept and the first is never chosen. Path is null if unusual or too long.
 */
export function analyzeSourceUrl(url: string): SourceAnalysis {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { path: null, order: { status: 'none' } };
  }
  const segments = parsed.pathname.split('/').filter((s) => s !== '' && !/^ref=/i.test(s));
  const basePath = `/${segments.join('/')}`;
  const queryIds = ORDER_QUERY_KEYS.flatMap((k) => parsed.searchParams.getAll(k)).filter((v) => ORDER_ID_PATTERN.test(v));
  const order = orderContextOf([...orderIdsInPathSegments(basePath), ...queryIds]);
  if (!SAFE_PATH.test(basePath)) return { path: null, order };
  const path = order.status === 'found' && queryIds.length > 0 ? `${basePath}?orderID=${order.value}` : basePath;
  return { path: path.length <= SOURCE_PATH_MAX ? path : null, order };
}

export function sanitizeSourcePath(url: string): string | null {
  return analyzeSourceUrl(url).path;
}

/** Order context of stored provenance: the single order ID retained in its path, if any. */
export function orderFromSourcePath(sourcePath: string | null): OrderContext {
  if (sourcePath === null) return { status: 'none' };
  const [path = '', query] = sourcePath.split('?');
  const queryIds = query === undefined ? [] : [query.replace(/^orderID=/, '')].filter((v) => ORDER_ID_PATTERN.test(v));
  return orderContextOf([...orderIdsInPathSegments(path), ...queryIds]);
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
