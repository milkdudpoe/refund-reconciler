// Loads the built dist/ as an unpacked MV3 extension into Playwright's bundled
// Chromium using a persistent profile, so tests exercise the real service
// worker, chrome.runtime messaging and chrome.storage.local.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';

export const DIST = resolve(import.meta.dirname, '../../dist');
export const STORE_KEY = 'refundReconciler.store';

export class ExtensionSession {
  context: BrowserContext | null = null;
  extensionId = '';

  constructor(readonly userDataDir: string) {}

  async launch(): Promise<void> {
    if (!existsSync(join(DIST, 'manifest.json'))) throw new Error('dist/ is missing; run `npm run build` first.');
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    let [worker] = this.context.serviceWorkers();
    worker ??= await this.context.waitForEvent('serviceworker');
    this.extensionId = new URL(worker.url()).host;
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }

  get dashboardUrl(): string {
    return `chrome-extension://${this.extensionId}/dashboard.html`;
  }

  async openDashboard(): Promise<Page> {
    if (!this.context) throw new Error('not launched');
    const page = await this.context.newPage();
    await page.goto(this.dashboardUrl);
    await expect(page.getByRole('heading', { name: 'Your cases' }).or(page.getByTestId('unreadable'))).toBeVisible();
    return page;
  }
}

export const test = base.extend<{ session: ExtensionSession }>({
  // eslint-disable-next-line no-empty-pattern
  session: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'refund-reconciler-e2e-'));
    const session = new ExtensionSession(dir);
    await session.launch();
    await use(session);
    await session.close();
    await rm(dir, { recursive: true, force: true });
  },
});

export { expect };

// ---- UI helpers ----

export async function createCase(
  page: Page,
  opts: { orderRef?: string; items: { label: string; amount?: string; unknown?: boolean }[] },
): Promise<void> {
  await page.getByRole('button', { name: 'Create case' }).click();
  if (opts.orderRef) await page.getByLabel('Order reference (optional)').fill(opts.orderRef);
  for (const [i, item] of opts.items.entries()) {
    if (i > 0) await page.getByRole('button', { name: 'Add another item' }).click();
    await page.getByLabel(`Item ${i + 1} description`).fill(item.label);
    if (item.unknown) await page.getByLabel('Unknown').nth(i).check();
    else await page.getByLabel(`Item ${i + 1} expected refund (USD)`).fill(item.amount ?? '');
  }
  await page.getByRole('button', { name: 'Save case' }).click();
}

export function itemCard(page: Page, label: string) {
  return page.getByTestId('item').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
}

export async function recordForItem(
  page: Page,
  label: string,
  action: 'Record merchant report' | 'Confirm money received' | 'Record recharge' | 'Edit expected amount',
  amount: string,
  extra: { reference?: string; note?: string } = {},
): Promise<void> {
  await itemCard(page, label).getByRole('button', { name: action }).click();
  const form = page.getByTestId('entry-form');
  await form.getByRole('textbox', { name: /USD/ }).fill(amount);
  if (extra.reference) await form.getByLabel(/reference/).fill(extra.reference);
  if (extra.note) await form.getByLabel('Note (optional)').fill(extra.note);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('entry-form')).toHaveCount(0);
}
