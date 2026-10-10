// Task 06: the "How to use Refund Reconciler" guide, through the built
// extension's real dashboard and popup. The guide is a static disclosure: these
// tests check that it is reachable by keyboard and from the popup, never opens
// by itself, never writes, and leaves every piece of dashboard state alone.

import type { Page } from '@playwright/test';
import { createCase, expect, itemCard, test } from './fixtures';
import { storedRaw } from './export-helpers';
import { mixedLedger } from '../shared/overview-ledger';
import { chooseBackup, dropNextSend, envelopeOf, holdNextSend, openRestore, releaseSend, scratchDir, waitForHeldSend, writeBackupFile } from './restore-helpers';

const help = (p: Page) => p.getByTestId('help');
const helpSummary = (p: Page) => p.locator('#help-summary');
const search = (p: Page) => p.getByLabel('Search by order reference or item description');
const statusFilter = (p: Page) => p.getByLabel('Status', { exact: true });

/** Records every message and storage write this page attempts, without changing them. */
async function recordWrites(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __writes: string[] };
    w.__writes = [];
    const rt = chrome.runtime as unknown as Record<string, unknown>;
    const area = chrome.storage.local as unknown as Record<string, unknown>;
    const wrap = (o: Record<string, unknown>, k: string, label: string) => {
      const real = (o[k] as (...a: unknown[]) => unknown).bind(o);
      o[k] = (...args: unknown[]) => {
        w.__writes.push(label);
        return real(...args);
      };
    };
    // Reads of saved data also go through sendMessage; only other messages are changes.
    const send = (rt.sendMessage as (m: unknown) => unknown).bind(rt);
    rt.sendMessage = (m: unknown) => {
      if ((m as { kind?: string } | null)?.kind !== 'read') w.__writes.push('sendMessage');
      return send(m);
    };
    for (const k of ['set', 'remove', 'clear'] as const) wrap(area, k, `storage.${k}`);
  });
}

const writes = (p: Page) => p.evaluate(() => (window as unknown as { __writes: string[] }).__writes);

/** Opens and closes the guide with the keyboard, reading one nested section on the way. */
async function useHelp(p: Page): Promise<void> {
  await helpSummary(p).focus();
  await p.keyboard.press('Enter');
  await expect(help(p)).toHaveAttribute('open', '');
  await help(p).getByText('Where your data is kept').click();
  await expect(help(p).getByText('Backups, summaries and text you copy are ordinary, unencrypted files or text.')).toBeVisible();
  await help(p).getByText('Where your data is kept').click();
  await expect(help(p).getByText('Backups, summaries and text you copy are ordinary, unencrypted files or text.')).toBeHidden();
  await helpSummary(p).focus();
  await p.keyboard.press('Enter');
  await expect(help(p)).not.toHaveAttribute('open');
}

test('the guide starts closed, works by keyboard and at narrow width, explains the workflow and writes nothing', async ({ session }) => {
  const page = await session.openDashboard();
  // A fresh load after "Protect your records", so keyboard navigation starts from the top of the page.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 720 });
  await recordWrites(page);
  await expect(help(page)).toBeVisible();
  await expect(help(page)).not.toHaveAttribute('open');
  await expect(help(page).getByRole('list').first()).toBeHidden();

  // Keyboard: Tab reaches the disclosure from the top of the page; Enter/Space toggle it.
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(helpSummary(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(help(page)).toHaveAttribute('open', '');
  const steps = help(page).locator('.help-steps > li');
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText('Create case');
  await expect(steps.nth(0)).toContainText('Unknown');
  await expect(steps.nth(1)).toContainText('not proof that you were paid');
  await expect(steps.nth(2)).toContainText('Confirm money received');
  await expect(steps.nth(2)).toContainText('Record recharge');
  await expect(steps.nth(2)).toContainText('Void');
  await expect(steps.nth(3)).toContainText('Needs attention');
  await expect(steps.nth(3)).toContainText('only into a ledger with no cases');
  await expect(help(page)).toContainText('Load synthetic demo');
  await expect(help(page)).toContainText('It is never loaded for you.');

  // Nested details open with Space and stay readable at 360 px without sideways scrolling.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(help(page).getByText('About capturing selected text')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(help(page)).toContainText('tested only on synthetic examples, not on real Amazon refund pages');
  await expect(help(page)).toContainText('Capture works only while your records are unlocked');
  await expect(help(page)).toContainText('While your records are locked, the toolbar popup reads nothing from the page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await helpSummary(page).focus();
  await page.keyboard.press('Space');
  await expect(help(page)).not.toHaveAttribute('open');

  // Nothing was sent or written, the demo was not loaded, and a reload does not reopen the guide.
  expect(await writes(page)).toEqual([]);
  expect(await storedRaw(page)).toEqual({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: expect.any(String) });
  await expect(page.getByTestId('demo-cases')).toHaveCount(0);
  await page.reload();
  await expect(help(page)).not.toHaveAttribute('open');
});

test('the popup links to the guide, which opens in a new dashboard tab without disturbing an open one', async ({ session }) => {
  const dash = await session.openDashboard();
  await createCase(dash, { orderRef: 'HELP-1', items: [{ label: 'Synthetic lamp', amount: '20' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await search(dash).fill('lamp');
  const before = await storedRaw(dash);

  const popup = await session.context!.newPage();
  await popup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  const opened = session.context!.waitForEvent('page', (p) => p.url().endsWith('/dashboard.html#help'));
  await popup.getByRole('button', { name: 'How to use Refund Reconciler' }).click();
  const guide = await opened;
  await expect(help(guide)).toHaveAttribute('open', '');
  // The new tab may open in the background, so check the page's own focused element.
  expect(await guide.evaluate(() => document.activeElement?.id)).toBe('help-summary');
  await expect(guide.getByRole('heading', { name: 'Your cases' })).toBeVisible();

  await expect(search(dash)).toHaveValue('lamp');
  await expect(help(dash)).not.toHaveAttribute('open');
  expect(await storedRaw(guide)).toEqual(before);
});

test('using the guide keeps search, status, drafts, open export and restore panels, and pending or uncertain saves', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'HELP-A', items: [{ label: 'Synthetic kettle', amount: '30' }] });
  await page.getByRole('button', { name: '← All cases' }).click();
  await createCase(page, { orderRef: 'HELP-B', items: [{ label: 'Synthetic toaster', amount: '45' }] });
  await page.getByRole('button', { name: '← All cases' }).click();
  const saved = (await storedRaw(page)) as { revision: number };
  await recordWrites(page);

  // List view: search and status filter.
  await search(page).fill('kettle');
  await statusFilter(page).selectOption('attention');
  await useHelp(page);
  await expect(search(page)).toHaveValue('kettle');
  await expect(statusFilter(page)).toHaveValue('attention');
  await expect(page.getByTestId('real-cases').getByTestId('case-row')).toHaveCount(1);

  // Create-case draft.
  await page.getByRole('button', { name: 'Create case' }).click();
  await page.getByLabel('Order reference (optional)').fill('DRAFT-1');
  await page.getByLabel('Item 1 description').fill('Half-typed item');
  await useHelp(page);
  await expect(page.getByLabel('Order reference (optional)')).toHaveValue('DRAFT-1');
  await expect(page.getByLabel('Item 1 description')).toHaveValue('Half-typed item');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(search(page)).toHaveValue('kettle');

  // Open export and restore panels.
  await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await useHelp(page);
  await expect(page.getByTestId('export-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download JSON', exact: true })).toBeEnabled();
  await page.getByTestId('export-panel').getByRole('button', { name: 'Close' }).click();
  const scratch = await scratchDir();
  try {
    await openRestore(page);
    await chooseBackup(page, await writeBackupFile(scratch.dir, 'b.json', envelopeOf(JSON.parse(JSON.stringify(mixedLedger().store)))));
    const panel = page.getByTestId('restore-panel');
    await expect(panel).toContainText('Selected file: b.json');
    const phase = await panel.getAttribute('data-phase');
    const panelText = await panel.textContent();
    await useHelp(page);
    await expect(panel).toHaveAttribute('data-phase', phase!);
    expect(await panel.textContent()).toBe(panelText);
    await page.locator('#restore-cancel').click();
  } finally {
    await scratch.cleanup();
  }
  expect(await writes(page)).toEqual([]);
  expect(((await storedRaw(page)) as { revision: number }).revision).toBe(saved.revision);

  // Entry draft, then a save held in flight, then a save whose outcome is unknown.
  await page.getByTestId('real-cases').getByTestId('case-row').filter({ hasText: 'kettle' }).click();
  await itemCard(page, 'Synthetic kettle').getByRole('button', { name: 'Confirm money received' }).click();
  const form = page.getByTestId('entry-form');
  await form.getByRole('textbox', { name: /USD/ }).fill('12.34');
  await form.getByLabel('Note (optional)').fill('seen on statement');
  await useHelp(page);
  await expect(form.getByRole('textbox', { name: /USD/ })).toHaveValue('12.34');
  await expect(form.getByLabel('Note (optional)')).toHaveValue('seen on statement');

  await dropNextSend(page);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('notice')).toContainText('Your input is kept');
  await useHelp(page);
  await expect(page.getByTestId('notice')).toContainText('Your input is kept');
  await expect(form.getByRole('textbox', { name: /USD/ })).toHaveValue('12.34');

  await holdNextSend(page);
  await form.getByRole('button', { name: 'Save' }).click();
  await waitForHeldSend(page);
  await useHelp(page);
  await releaseSend(page);
  await expect(page.getByTestId('entry-form')).toHaveCount(0);
  const after = (await storedRaw(page)) as { revision: number; cases: { entries: { kind: string; amountCents: number }[] }[] };
  const receipts = after.cases.flatMap((c) => c.entries).filter((e) => e.kind === 'receipt');
  expect(receipts).toEqual([expect.objectContaining({ amountCents: 1234 })]);
  expect(after.revision).toBe(saved.revision + 1);
});
