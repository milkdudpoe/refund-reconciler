// Task 09.1: stale replies after Lock or erase. Real popup, real dashboards,
// real service worker and runtime messaging; replies are held only AFTER the
// real worker answered them (vault-helpers.ts holdNextReplyOfKind), so every
// ordering below is deterministic and the production code is unchanged. All
// data is SYNTHETIC. Capture tests use the synthetic fixture pages and the
// temporary test copy with fixture-only host access (see capture-fixtures.ts).

import type { BrowserContext, Page } from '@playwright/test';
import { createCase, type ExtensionSession } from './fixtures';
import { ORDER_A, expect, openPopup, openSource, selectBlock, test } from './capture-fixtures';
import { countDownloads } from './export-helpers';
import {
  LEGACY_KEY,
  downloadStarts,
  eraseTyped,
  holdNextReplyOfKind,
  instrumentDownloads,
  ledgerStatus,
  migrateViaUi,
  releaseReplyOfKind,
  setupViaUi,
  unlockViaUi,
  vaultScreen,
  waitForHeldReplyOfKind,
} from './vault-helpers';
import { richLegacyLedger } from '../shared/rich-ledger';

const CANARY = 'SYNTHETIC-RACE-CANARY-41d2';

async function openPopupPage(session: ExtensionSession): Promise<Page> {
  const popup = await session.context!.newPage();
  await popup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  return popup;
}

/** Counts tab look-ups and script injections in extension pages (installed before page scripts run). */
async function instrumentTabAccess(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const c = chrome as unknown as { tabs?: Record<string, unknown>; scripting?: Record<string, unknown> };
    if (!c.tabs || !c.scripting) return;
    const w = window as unknown as { __tabAccess: string[] };
    w.__tabAccess = [];
    for (const [ns, fn] of [['tabs', 'query'], ['tabs', 'get'], ['scripting', 'executeScript']] as const) {
      const obj = c[ns]!;
      const real = (obj[fn] as (...a: unknown[]) => unknown).bind(obj);
      obj[fn] = (...args: unknown[]) => {
        w.__tabAccess.push(`${ns}.${fn}`);
        return real(...args);
      };
    }
  });
}
const tabAccess = (p: Page) => p.evaluate(() => (window as unknown as { __tabAccess?: string[] }).__tabAccess ?? ['not instrumented']);
const resetTabAccess = (p: Page) => p.evaluate(() => { (window as unknown as { __tabAccess: string[] }).__tabAccess = []; });

const captureButton = (p: Page) => p.getByRole('button', { name: 'Capture selected refund text' });

test.describe('the popup never applies an older reply over a newer state', () => {
  test('an idle popup’s unlocked refresh, released after a newer Lock, cannot restore Capture; a genuine unlock does', async ({ production: session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'RACE-1', items: [{ label: `${CANARY} lamp`, amount: '30' }] });
    const b = await session.openDashboard();
    const popup = await openPopupPage(session);
    await expect(captureButton(popup)).toBeVisible();

    // A subscribed refresh: its read is answered by the real worker (unlocked), but delivery is held.
    await holdNextReplyOfKind(popup, 'read');
    await a.getByRole('button', { name: '← All cases' }).click();
    await createCase(a, { orderRef: 'RACE-2', items: [{ label: 'Synthetic second item', amount: '5' }] });
    await waitForHeldReplyOfKind(popup, 'read');

    // A newer Lock reaches the popup first.
    await b.getByRole('button', { name: 'Lock now' }).click();
    await expect(popup.getByTestId('popup-locked')).toBeVisible();
    expect(await ledgerStatus(b)).toBe('locked');

    // The older unlocked reply arrives last and is discarded.
    await releaseReplyOfKind(popup, 'read');
    await expect(popup.getByTestId('popup-locked')).toBeVisible();
    await expect(captureButton(popup)).toHaveCount(0);
    await expect(popup.locator('body')).not.toContainText(CANARY);
    expect(await ledgerStatus(b)).toBe('locked');

    // A genuine unlock restores Capture.
    await unlockViaUi(b);
    await expect(captureButton(popup)).toBeVisible();
  });

  test('the same ordering across erase cannot restore the erased ledger’s unlocked state', async ({ production: session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'RACE-E', items: [{ label: `${CANARY} kettle`, amount: '12' }] });
    const popup = await openPopupPage(session);
    await expect(captureButton(popup)).toBeVisible();

    await holdNextReplyOfKind(popup, 'read');
    await a.getByRole('button', { name: '← All cases' }).click();
    await createCase(a, { orderRef: 'RACE-E2', items: [{ label: 'Synthetic other', amount: '3' }] });
    await waitForHeldReplyOfKind(popup, 'read');

    await a.getByRole('button', { name: 'Lock now' }).click();
    await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
    await eraseTyped(a);
    await expect(popup.getByTestId('popup-locked')).toHaveAttribute('data-state', 'setup_required');
    expect(await ledgerStatus(a)).toBe('setup_required');

    await releaseReplyOfKind(popup, 'read');
    await expect(popup.getByTestId('popup-locked')).toHaveAttribute('data-state', 'setup_required');
    await expect(captureButton(popup)).toHaveCount(0);

    // A new setup is a genuine new unlocked state.
    await setupViaUi(a, 'a second synthetic phrase 7');
    await expect(captureButton(popup)).toBeVisible();
  });

  test('an older locked reply, overtaken by a newer genuine unlock, cannot re-lock the popup', async ({ production: session }) => {
    await session.openDashboard();
    const b = await session.openDashboard();
    const popup = await openPopupPage(session);
    await expect(captureButton(popup)).toBeVisible();

    // The Lock's own refresh is answered "locked" by the worker; its delivery is held.
    await holdNextReplyOfKind(popup, 'read');
    await b.getByRole('button', { name: 'Lock now' }).click();
    await waitForHeldReplyOfKind(popup, 'read');
    await unlockViaUi(b);
    await expect(captureButton(popup)).toBeVisible();
    expect(await ledgerStatus(b)).toBe('ok');

    await releaseReplyOfKind(popup, 'read');
    await expect(captureButton(popup)).toBeVisible();
    await expect(popup.getByTestId('popup-locked')).toHaveCount(0);
  });

  test('a held capture check released after Lock cannot restore capture, look up the tab, read the selection or inject', async ({ granted }) => {
    await instrumentTabAccess(granted.context!);
    const dash = await granted.openDashboard();
    await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
    const { page, windowId } = await openSource(granted);
    await selectBlock(page, 'issued-70');
    const popup = await openPopup(granted, windowId);
    // Opening while unlocked looked up the tab once, as designed; count only what happens from here.
    await expect.poll(() => tabAccess(popup)).toEqual(['tabs.query']);
    await resetTabAccess(popup);

    await holdNextReplyOfKind(popup, 'read');
    await captureButton(popup).click();
    await waitForHeldReplyOfKind(popup, 'read');
    await dash.getByRole('button', { name: 'Lock now' }).click();
    await expect(popup.getByTestId('popup-locked')).toBeVisible();

    await releaseReplyOfKind(popup, 'read');
    await expect(popup.getByTestId('popup-locked')).toBeVisible();
    await expect(captureButton(popup)).toHaveCount(0);
    await expect(popup.getByTestId('preview')).toHaveCount(0);
    await expect(popup.getByTestId('excerpt')).toHaveCount(0);
    expect(await tabAccess(popup)).toEqual([]);

    // After a genuine unlock, capture works again.
    await unlockViaUi(dash);
    await expect(captureButton(popup)).toBeVisible();
    await captureButton(popup).click();
    await expect(popup.getByTestId('excerpt')).toContainText('Refund issued: $70.00');
    expect(await tabAccess(popup)).toEqual(expect.arrayContaining(['tabs.get', 'scripting.executeScript']));
  });
});

test.describe('a plaintext migration backup never starts after its state became obsolete', () => {
  async function legacyDashboards(session: ExtensionSession): Promise<{ a: Page; b: Page; legacy: ReturnType<typeof richLegacyLedger> }> {
    const a = await session.openDashboard({ unlock: false });
    const legacy = richLegacyLedger();
    (legacy.cases[1] as { orderRef: string | null }).orderRef = CANARY;
    await a.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, legacy] as const);
    await a.reload();
    await expect(vaultScreen(a, 'vault-migrate')).toBeVisible();
    const b = await session.openDashboard({ unlock: false });
    await expect(vaultScreen(b, 'vault-migrate')).toBeVisible();
    await instrumentDownloads(a);
    return { a, b, legacy };
  }

  test('a held backup reply released after an erase in another view downloads nothing and leaves no stale message', async ({ production: session }) => {
    const { a, b, legacy } = await legacyDashboards(session);
    const downloads = countDownloads(a);

    // In the unchanged allowed state, the backup works and is the complete plaintext ledger.
    const [dl] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click()]);
    const file = JSON.parse(await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8'));
    expect(file).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(file.store).toEqual(legacy);
    expect(await downloadStarts(a)).toBe(1);

    // A second backup: the worker answers readLegacy, delivery is held; no download has started.
    await holdNextReplyOfKind(a, 'readLegacy');
    await a.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click();
    await waitForHeldReplyOfKind(a, 'readLegacy');
    expect(await downloadStarts(a)).toBe(1);

    await eraseTyped(b);
    await expect(vaultScreen(a, 'vault-setup')).toBeVisible();
    expect(await a.evaluate(() => chrome.storage.local.get(null))).toEqual({ 'refundReconciler.erased': expect.objectContaining({ format: 'refund-reconciler-erased' }) });

    await releaseReplyOfKind(a, 'readLegacy');
    await expect(vaultScreen(a, 'vault-setup')).toBeVisible();
    expect(await downloadStarts(a)).toBe(1);
    expect(downloads.count).toBe(1);
    await expect(a.getByTestId('vault-feedback')).toHaveCount(0);
    await expect(a.locator('#app')).not.toContainText(`${legacy.cases.length} cases`);
    await expect(a.locator('#app')).not.toContainText(CANARY);
    await expect(a.getByRole('button', { name: 'Protect my records' })).toBeEnabled();
    expect(await a.evaluate(() => chrome.storage.local.get(null))).toEqual({ 'refundReconciler.erased': expect.anything() });
  });

  test('a held backup reply released after the migration finished elsewhere and the records locked downloads nothing', async ({ production: session }) => {
    const { a, b } = await legacyDashboards(session);
    await holdNextReplyOfKind(a, 'readLegacy');
    await a.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click();
    await waitForHeldReplyOfKind(a, 'readLegacy');

    await migrateViaUi(b);
    await b.getByRole('button', { name: 'Lock now' }).click();
    await expect(vaultScreen(b, 'vault-locked')).toBeVisible();
    await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
    expect(Object.keys(await a.evaluate(() => chrome.storage.local.get(null)))).toEqual(['refundReconciler.vault']);

    await releaseReplyOfKind(a, 'readLegacy');
    await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
    expect(await downloadStarts(a)).toBe(0);
    await expect(a.getByTestId('vault-feedback')).toHaveCount(0);
    await expect(a.locator('#app')).not.toContainText(CANARY);
    await expect(a.getByRole('button', { name: 'Unlock', exact: true })).toBeEnabled();
    await expect(a.getByLabel('Passphrase', { exact: true })).toHaveValue('');
  });
});
