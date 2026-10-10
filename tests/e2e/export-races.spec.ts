// Task 03.1 regressions: export snapshots and clipboard completion under real
// interleavings. Reads are held only AFTER the real chrome.storage.local.get
// has returned old data; mutations go through the real, serialised service
// worker from a second dashboard; clipboard writes are real and only their
// completion is gated. All gates are deterministic (no sleeps) and live in
// test code.

import type { Page } from '@playwright/test';
import { createCase, expect, itemCard, recordForItem, test, type ExtensionSession } from './fixtures';
import {
  clipboardCalls,
  countDownloads,
  downloadVia,
  gateClipboard,
  holdNextRead,
  openSummary,
  pasteClipboard,
  releaseHeldRead,
  restoreClipboard,
  settleClipboard,
  storedRaw,
  waitForHeldRead,
  waitForPendingCopy,
} from './export-helpers';

async function openCaseIn(session: ExtensionSession, orderRef: string): Promise<Page> {
  const page = await session.openDashboard();
  await page.getByTestId('case-row').filter({ hasText: orderRef }).click();
  return page;
}

/** A case with $25 confirmed received, open in two dashboards. */
async function twoDashboards(session: ExtensionSession, orderRef = 'RACE-1'): Promise<{ a: Page; b: Page }> {
  const a = await session.openDashboard();
  await createCase(a, { orderRef, items: [{ label: 'Chair', amount: '100' }] });
  await recordForItem(a, 'Chair', 'Confirm money received', '25');
  const b = await openCaseIn(session, orderRef);
  return { a, b };
}

/** Never: an earlier snapshot shown without a warning while export is enabled. */
async function expectNotExportableAsCurrent(page: Page, oldText: RegExp): Promise<void> {
  const value = await page.getByTestId('export-text').inputValue();
  if (oldText.test(value)) {
    await expect(page.getByTestId('export-stale')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download text' })).toBeDisabled();
  }
}

test.describe('snapshot reads racing storage changes', () => {
  test('1: a case changed during the initial read cannot export $25 as current once $55 was observed', async ({ session }) => {
    const { a, b } = await twoDashboards(session);
    await holdNextRead(a);
    await a.getByRole('button', { name: 'Prepare case summary…' }).click();
    await waitForHeldRead(a); // the export's read has returned $25 and is held

    await recordForItem(b, 'Chair', 'Confirm money received', '30');
    await expect(itemCard(a, 'Chair').getByTestId('item-net')).toHaveText('$55.00'); // A has observed the change
    const afterB = await storedRaw(b); // includes B's deliberate write
    await releaseHeldRead(a);

    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$55\.00/);
    await expectNotExportableAsCurrent(a, /Confirmed net received: \$25\.00/);
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    const file = await downloadVia(a, 'Download text');
    expect(file.text).toContain('Confirmed net received: $55.00');
    expect(file.text).not.toContain('Confirmed net received: $25.00');
    expect(file.text).toBe(await a.getByTestId('export-text').inputValue());
    expect(await storedRaw(a)).toEqual(afterB); // the export itself wrote nothing
  });

  test('2: a case deleted during the initial read is never exportable as current', async ({ session }) => {
    const { a, b } = await twoDashboards(session, 'RACE-DEL');
    const downloads = countDownloads(a);
    await holdNextRead(a);
    await a.getByRole('button', { name: 'Prepare case summary…' }).click();
    await waitForHeldRead(a);

    await b.getByRole('button', { name: 'Delete case…' }).click();
    await b.getByRole('button', { name: 'Permanently delete' }).click();
    await expect(a.getByTestId('notice')).toHaveText('That case was deleted in another view.');
    await releaseHeldRead(a);

    await expect(a.getByTestId('export-missing')).toContainText('no longer exists in saved data');
    await expect(a.getByTestId('export-text')).toHaveCount(0);
    await expect(a.getByRole('button', { name: 'Download text' })).toHaveCount(0);
    await expect(a.getByRole('button', { name: 'Copy text' })).toHaveCount(0);
    expect(downloads.count).toBe(0);
  });

  test('3: a case created during a JSON export read never yields the earlier empty store as current', async ({ session }) => {
    const a = await session.openDashboard();
    const b = await session.openDashboard();
    await holdNextRead(a);
    await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
    await waitForHeldRead(a); // holds the empty store

    await createCase(b, { orderRef: 'RACE-JSON', items: [{ label: 'Desk', amount: '80' }] });
    await expect(a.getByTestId('case-row').filter({ hasText: 'RACE-JSON' })).toBeVisible();
    await releaseHeldRead(a);

    await expect(a.getByTestId('export-real-count')).toHaveText('1');
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    const backup = JSON.parse((await downloadVia(a, 'Download JSON')).text);
    expect(backup.store.cases).toHaveLength(1);
    expect(backup.store).toEqual(await storedRaw(a));
  });

  test('4: a change during Refresh gets the same guarantees, and refresh recovers once storage settles', async ({ session }) => {
    const { a, b } = await twoDashboards(session, 'RACE-REF');
    await openSummary(a);
    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$25\.00/);

    // First change marks the open preview stale.
    await recordForItem(b, 'Chair', 'Confirm money received', '30');
    await expect(a.getByTestId('export-stale')).toBeVisible();

    // A second change lands while the refresh read is held with $55.
    await holdNextRead(a);
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await waitForHeldRead(a);
    await recordForItem(b, 'Chair', 'Confirm money received', '10');
    await expect(itemCard(a, 'Chair').getByTestId('item-net')).toHaveText('$65.00');
    const afterB = await storedRaw(b);
    await releaseHeldRead(a);

    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$65\.00/);
    await expectNotExportableAsCurrent(a, /Confirmed net received: \$55\.00/);
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    const file = await downloadVia(a, 'Download text');
    expect(file.text).toContain('Confirmed net received: $65.00');
    expect(file.text).toBe(await a.getByTestId('export-text').inputValue());

    // A refresh read that FAILS while storage changes stays blocked, then recovers.
    await a.evaluate(() => {
      const area = chrome.storage.local as unknown as { get: unknown };
      const w = window as unknown as { __realGet: unknown };
      area.get = () => Promise.reject(new Error('Simulated read failure'));
      (window as unknown as { __restore: () => void }).__restore = () => {
        area.get = w.__realGet;
      };
    });
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(a.getByTestId('export-blocked')).toContainText('Simulated read failure');
    await a.evaluate(() => (window as unknown as { __restore: () => void }).__restore());
    await a.getByRole('button', { name: 'Try again' }).click();
    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$65\.00/);
    await expect(a.getByRole('button', { name: 'Download text' })).toBeEnabled();
    expect(await storedRaw(a)).toEqual(afterB);
  });
});

test.describe('clipboard completion is bound to the copied preview', () => {
  async function privateCase(session: ExtensionSession): Promise<Page> {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'CLIP-1', items: [{ label: 'Kettle', amount: '40' }] });
    await recordForItem(a, 'Kettle', 'Confirm money received', '15', { note: 'PRIVATE-NOTE-XYZ' });
    return a;
  }

  test('a pending copy with details cannot be turned into an apparently copied redacted preview', async ({ session }) => {
    const a = await privateCase(session);
    const before = await storedRaw(a);
    await openSummary(a);
    await a.getByLabel(/Include evidence details/).check();
    const withNote = await a.getByTestId('export-text').inputValue();
    expect(withNote).toContain('Note: PRIVATE-NOTE-XYZ');

    await gateClipboard(a);
    await a.getByRole('button', { name: /Copy/ }).click();
    await waitForPendingCopy(a);
    // The real clipboard already holds the version with the note.
    expect((await clipboardCalls(a)).written).toEqual([withNote]);

    // While copying, the preview cannot be replaced.
    const details = a.getByLabel(/Include evidence details/);
    await expect(details).toBeDisabled();
    await expect(details).toBeChecked();
    await expect(a.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await expect(a.getByTestId('export-feedback')).toContainText('Copying');

    await settleClipboard(a, 'resolve');
    const feedback = a.getByTestId('export-feedback');
    await expect(feedback).toContainText('Copied');
    await expect(feedback).toContainText('evidence details included');
    await expect(a.getByTestId('export-text')).toHaveValue(withNote);
    await expect(details).toBeChecked();
    await expect(details).toBeEnabled();
    expect(await pasteClipboard(a)).toBe(withNote);

    // Turning details off afterwards does not claim the redacted text was copied.
    await details.uncheck();
    await expect(a.getByTestId('export-text')).not.toHaveValue(/PRIVATE-NOTE-XYZ/);
    await expect(a.getByTestId('export-feedback')).toHaveCount(0);
    expect(await storedRaw(a)).toEqual(before);
  });

  test('Refresh and a second Copy are refused while a copy is pending', async ({ session }) => {
    const a = await privateCase(session);
    await openSummary(a);
    const text = await a.getByTestId('export-text').inputValue();
    await gateClipboard(a);
    const copy = a.locator('#export-copy');
    await copy.click();
    await waitForPendingCopy(a);

    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    await expect(copy).toBeFocused();
    await copy.click({ force: true }); // a real second press while pending (aria-disabled is not actionable otherwise)
    await a.keyboard.press('Enter');
    await expect(a.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await a.getByRole('button', { name: 'Refresh preview' }).click({ force: true });
    expect((await clipboardCalls(a)).calls).toBe(1);
    await expect(a.getByTestId('export-text')).toHaveValue(text);

    await settleClipboard(a, 'resolve');
    await expect(a.getByTestId('export-feedback')).toContainText('Copied');
    await expect(copy).not.toHaveAttribute('aria-disabled', 'true');
    await expect(a.getByRole('button', { name: 'Refresh preview' })).toBeEnabled();
    expect((await clipboardCalls(a)).calls).toBe(1);
  });

  test('a storage change or deletion while copying keeps the stale warning and names the earlier snapshot', async ({ session }) => {
    const a = await privateCase(session);
    const b = await openCaseIn(session, 'CLIP-1');
    await openSummary(a);
    const copied = await a.getByTestId('export-text').inputValue();
    await gateClipboard(a);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForPendingCopy(a);

    await recordForItem(b, 'Kettle', 'Confirm money received', '5');
    const afterB = await storedRaw(b);
    await expect(a.getByTestId('export-stale')).toContainText('changed after this preview was made');
    await settleClipboard(a, 'resolve');
    const feedback = a.getByTestId('export-feedback');
    await expect(feedback).toContainText('earlier snapshot');
    await expect(feedback).not.toContainText('summary text shown below to the clipboard.');
    await expect(a.getByTestId('export-stale')).toBeVisible();
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
    await expect(a.getByTestId('export-text')).toHaveValue(copied);
    expect(await pasteClipboard(a)).toBe(copied);
    expect(await storedRaw(a)).toEqual(afterB);

    // Deletion while a fresh copy is pending.
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForPendingCopy(a);
    await b.getByRole('button', { name: 'Delete case…' }).click();
    await b.getByRole('button', { name: 'Permanently delete' }).click();
    await expect(a.getByTestId('export-stale')).toContainText('deleted from saved data');
    await settleClipboard(a, 'resolve');
    await expect(a.getByTestId('export-feedback')).toContainText('earlier snapshot');
    await expect(a.getByTestId('export-stale')).toContainText('deleted from saved data');
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
  });

  test('closing and reopening before completion leaves the new panel unaffected', async ({ session }) => {
    const a = await privateCase(session);
    await openSummary(a);
    await gateClipboard(a);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForPendingCopy(a);
    await a.getByRole('button', { name: 'Close' }).click();
    await expect(a.getByTestId('export-panel')).toHaveCount(0);

    await openSummary(a);
    await settleClipboard(a, 'resolve');
    // Give the late completion a chance to (wrongly) touch the new panel, then check it did not.
    await expect.poll(async () => (await clipboardCalls(a)).pending).toBe(false);
    await a.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(a.getByTestId('export-feedback')).toHaveCount(0);
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeEnabled();
    await expect(a.getByLabel(/Include evidence details/)).toBeEnabled();

    // The new panel's own copy works normally.
    await restoreClipboard(a);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await expect(a.getByTestId('export-feedback')).toContainText('Copied');
  });

  test('a rejected copy restores a usable manual-copy fallback and a later copy succeeds', async ({ session }) => {
    const a = await privateCase(session);
    const before = await storedRaw(a);
    await openSummary(a);
    const text = await a.getByTestId('export-text').inputValue();
    await gateClipboard(a, { realWrite: false });
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForPendingCopy(a);
    await settleClipboard(a, 'reject');

    await expect(a.getByTestId('export-feedback')).toContainText('The text was not copied');
    const area = a.getByTestId('export-text');
    await expect(area).toBeFocused();
    expect(await area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(text);
    await expect(a.getByLabel(/Include evidence details/)).toBeEnabled();
    await expect(a.getByRole('button', { name: 'Refresh preview' })).toBeEnabled();

    await restoreClipboard(a);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await expect(a.getByTestId('export-feedback')).toContainText('Copied');
    expect(await pasteClipboard(a)).toBe(text);
    expect(await storedRaw(a)).toEqual(before);
  });
});
