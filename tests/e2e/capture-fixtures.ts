// Browser-test support for selected-text capture.
//
// SYNTHETIC FIXTURES: every page served here is hand-written test HTML. It is
// not copied from Amazon, does not reflect Amazon's current markup or wording,
// and needs no account. Requests to fixture hosts are answered by Playwright
// routing inside the test browser; nothing reaches the network.
//
// GRANT PATH LIMITATION: a real toolbar click or keyboard shortcut (which is
// what grants activeTab) cannot be automated in this headless Playwright
// Chromium build (CDP Extensions.triggerAction is unavailable and synthetic
// key events do not reach extension command accelerators). So capture tests
// that need page access load an isolated TEMPORARY COPY of dist/ whose
// manifest adds host permissions for the synthetic fixture hosts only. The
// shipped dist/ is never modified; it is checked separately, including that it
// cannot read a page without a user grant.

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { DIST, ExtensionSession, STORE_KEY, expect, test as base } from './fixtures';

/** Hosts the temporary test copy may access. All serve synthetic fixtures. */
export const FIXTURE_HOST_PERMISSIONS = [
  'https://www.amazon.com/*',
  'https://amazon.com/*',
  // Unsupported hosts, granted only so the extension's own domain check (not
  // a missing permission) is what rejects them.
  'https://www.amazon.co.uk/*',
  'https://www.amazon.com.evil.example/*',
  'http://www.amazon.com/*',
];

export const ORDER_A = '112-1234567-7654321';
export const ORDER_B = '113-7654321-1234567';
export const ORDER_PAGE = `https://www.amazon.com/gp/your-account/order-details/ref=ppx_yo_dt_b_synthetic?ie=UTF8&orderID=${ORDER_A}&session-id=000-SYNTHETIC#top`;

const LONG = 'Synthetic filler text. '.repeat(260);

/** Synthetic blocks, selected by id in tests. */
const BLOCKS: Record<string, string> = {
  'issued-70': `<p>Order # ${ORDER_A}</p><p>Synthetic headphones</p><p>Refund issued: $70.00</p>`,
  'issued-35': '<p>Synthetic item B</p><p>Refund issued on October 3, 2026: $35.00</p>',
  'issued-35-order-b': `<p>Order # ${ORDER_B}</p><p>Refund issued: $35.00</p>`,
  'price-pending': '<p>Item price: $80.00</p><p>Refund pending: $70.00</p>',
  estimated: '<p>Estimated refund: $70.00</p><p>Return received</p>',
  multiple: '<p>Synthetic kettle</p><p>Refund issued: $35.00</p><p>Synthetic mug</p><p>Refund issued: $35.00</p>',
  aggregate: '<p>Refund summary</p><p>Refund issued for 3 items: $105.00</p>',
  euro: '<p>Refund issued: €70.00</p>',
  hostile: '<p>Refund issued: $70.00</p><p>&lt;img src=x onerror="window.__pwned=1"&gt;&lt;b&gt;bold&lt;/b&gt;</p>',
  long: `<p>Refund issued: $70.00</p><p>${LONG}</p>`,
};

export function fixturePage(title = 'Synthetic order details'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<!-- SYNTHETIC TEST FIXTURE: not Amazon markup or wording. -->
<p id="synthetic-banner">SYNTHETIC TEST FIXTURE — not an Amazon page</p>
${Object.entries(BLOCKS).map(([id, html]) => `<div id="${id}">${html}</div>`).join('\n')}
<textarea id="note-box">Refund issued: $70.00</textarea>
<input id="secret" type="password" value="hunter2">
</body></html>`;
}

/** Answers every http(s) request in the test browser with a synthetic page; nothing reaches the network. */
export async function installFixtureRoutes(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => url.protocol === 'https:' || url.protocol === 'http:',
    (route) => {
      const url = new URL(route.request().url());
      if (route.request().resourceType() !== 'document') return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixturePage(`Synthetic ${url.hostname}`) });
    },
  );
}

/** Copies dist/ to a temporary directory and adds fixture-only host permissions to the copy. */
export async function makeTestCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'refund-reconciler-testcopy-'));
  await cp(DIST, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = FIXTURE_HOST_PERMISSIONS;
  manifest.name = `${String(manifest.name)} [TEST COPY — fixture hosts only]`;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function newSession(extensionDir?: string): Promise<{ session: ExtensionSession; cleanup: () => Promise<void> }> {
  const profile = await mkdtemp(join(tmpdir(), 'refund-reconciler-e2e-'));
  const session = new ExtensionSession(profile, extensionDir);
  session.onLaunch = installFixtureRoutes;
  await session.launch();
  return {
    session,
    cleanup: async () => {
      await session.close();
      await rm(profile, { recursive: true, force: true });
      if (extensionDir) await rm(extensionDir, { recursive: true, force: true });
    },
  };
}

export const test = base.extend<{ granted: ExtensionSession; production: ExtensionSession }>({
  // Temporary test copy with fixture host access (stands in for the activeTab grant).
  // eslint-disable-next-line no-empty-pattern
  granted: async ({}, use) => {
    const { session, cleanup } = await newSession(await makeTestCopy());
    await use(session);
    await cleanup();
  },
  // The unmodified production dist/: no host access unless a real user gesture grants it.
  // eslint-disable-next-line no-empty-pattern
  production: async ({}, use) => {
    const { session, cleanup } = await newSession();
    await use(session);
    await cleanup();
  },
});

export { expect, STORE_KEY };

async function worker(session: ExtensionSession) {
  const [w] = session.context!.serviceWorkers();
  return w!;
}

/**
 * Opens a source tab with Playwright (so the synthetic route is guaranteed to
 * answer it) and finds its tab and window ids from the extension as the one
 * new tab. Tab ids are visible without any host access; URLs are not.
 */
export async function openSource(session: ExtensionSession, url = ORDER_PAGE): Promise<{ page: Page; tabId: number; windowId: number }> {
  const w = await worker(session);
  const known = new Set(await w.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id)));
  const page = await session.context!.newPage();
  await page.goto(url);
  await expect(page.locator('#synthetic-banner')).toBeVisible();
  const created = await w.evaluate(async (ids) => (await chrome.tabs.query({})).filter((t) => !ids.includes(t.id)).map((t) => ({ id: t.id!, windowId: t.windowId })), [...known]);
  expect(created).toHaveLength(1);
  return { page, tabId: created[0]!.id, windowId: created[0]!.windowId };
}

export async function selectBlock(page: Page, id: string): Promise<void> {
  await page.evaluate((blockId) => {
    const el = document.getElementById(blockId)!;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, id);
}

/**
 * Opens the real popup.html as a background tab in the source tab's window,
 * so the source tab stays the active tab the popup resolves on load (as when
 * the toolbar button is clicked). This does NOT simulate the user gesture.
 */
export async function openPopup(session: ExtensionSession, windowId: number): Promise<Page> {
  const w = await worker(session);
  const pagePromise = session.context!.waitForEvent('page', (p) => p.url().endsWith('/popup.html'));
  await w.evaluate((win) => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false, windowId: win }), windowId);
  const popup = await pagePromise;
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toBeVisible();
  return popup;
}

export async function storedRaw(session: ExtensionSession): Promise<unknown> {
  const w = await worker(session);
  return (await w.evaluate((key) => chrome.storage.local.get(key), STORE_KEY))[STORE_KEY];
}

interface StoredEntry {
  id: string;
  kind: string;
  itemId: string;
  amountCents: number | null;
  capture?: Record<string, unknown>;
}

export async function storedEntries(session: ExtensionSession): Promise<StoredEntry[]> {
  const raw = (await storedRaw(session)) as { cases: { entries: StoredEntry[] }[] } | undefined;
  return raw?.cases.flatMap((c) => c.entries) ?? [];
}
