// Loads the built dist/ as an unpacked MV3 extension into Playwright's bundled
// Chromium using a persistent profile, so tests exercise the real service
// worker, chrome.runtime messaging and chrome.storage.local.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { TEST_PHRASE, acceptViaUi, anyScreen, consentGate, setupViaUi, unlockViaUi } from './vault-helpers';

export const DIST = resolve(import.meta.dirname, '../../dist');
/** The plaintext key used by versions before 0.7.0 (read only for migration). */
export const STORE_KEY = 'refundReconciler.store';

export class ExtensionSession {
  context: BrowserContext | null = null;
  extensionId = '';
  /** Runs after each launch once the service worker is up, before any page opens (installs fixture routes). */
  onLaunch: ((context: BrowserContext) => Promise<void>) | null = null;

  constructor(
    readonly userDataDir: string,
    /** The unpacked extension to load: the production dist/ unless a test copy is given. */
    readonly extensionDir: string = DIST,
    /** Extra persistent-context options (viewport, scale, locale, time zone); the extension flags are always set here. */
    readonly contextOptions: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; locale?: string; timezoneId?: string } = {},
  ) {}

  async launch(): Promise<void> {
    if (!existsSync(join(this.extensionDir, 'manifest.json'))) {
      throw new Error(`${this.extensionDir} has no manifest.json; run \`npm run build\` (or \`npm run package:beta\` for the archive test) first.`);
    }
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      ...this.contextOptions,
      channel: 'chromium',
      args: [`--disable-extensions-except=${this.extensionDir}`, `--load-extension=${this.extensionDir}`],
    });
    let [worker] = this.context.serviceWorkers();
    worker ??= await this.context.waitForEvent('serviceworker');
    this.extensionId = new URL(worker.url()).host;
    // The worker can be reported before Chrome has bound the extension APIs in it.
    await expect.poll(() => worker.evaluate(() => typeof chrome.storage?.local), { timeout: 10_000 }).toBe('object');
    await this.onLaunch?.(this.context);
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }

  get dashboardUrl(): string {
    return `chrome-extension://${this.extensionId}/dashboard.html`;
  }

  /**
   * Opens a dashboard. By default, if the data-practices screen is shown
   * (a version with the consent gate, not yet agreed in this profile), it
   * agrees through the real UI, then completes "Protect your records" (fresh
   * profile) or unlocks (after a browser restart) with the synthetic
   * TEST_PHRASE, as a user would. Earlier baseline versions have no such
   * screen, so nothing is clicked for them. `{ accept: false }` stops at the
   * data-practices screen; `{ unlock: false }` returns whatever screen follows
   * agreement.
   */
  async openDashboard(opts: { unlock?: boolean; accept?: boolean } = {}): Promise<Page> {
    if (!this.context) throw new Error('not launched');
    const page = await this.context.newPage();
    await page.goto(this.dashboardUrl);
    await expect(anyScreen(page)).toBeVisible();
    if (opts.accept === false) return page;
    if (await consentGate(page).isVisible()) {
      await acceptViaUi(page);
      await expect(anyScreen(page)).toBeVisible();
    }
    if (opts.unlock === false) return page;
    if (await page.getByTestId('vault-setup').isVisible()) await setupViaUi(page, TEST_PHRASE);
    else if (await page.getByTestId('vault-locked').isVisible()) await unlockViaUi(page, TEST_PHRASE);
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
