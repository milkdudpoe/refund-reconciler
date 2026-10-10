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
  overridePageReads,
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

// Task 03.2: a storage change must lock a ready export at event time, before
// its revalidation read resolves. Each test holds the dashboard's
// change-triggered read (after the real API has read it); observing that held
// read proves the page has already processed the storage-change event.
test.describe('ready exports lock immediately on a storage change', () => {
  async function expectLockedWhileChecking(page: Page, kind: 'summary' | 'backup'): Promise<void> {
    await expect(page.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'checking');
    await expect(page.getByTestId('export-stale')).toContainText('earlier, unverified snapshot');
    if (kind === 'summary') {
      await expect(page.getByRole('button', { name: 'Copy text' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Download text' })).toBeDisabled();
    } else {
      await expect(page.getByRole('button', { name: 'Download JSON' })).toBeDisabled();
    }
  }

  test('ready summary, changed case: export is refused before the revalidation read resolves', async ({ session }) => {
    const { a, b } = await twoDashboards(session, 'EVT-1');
    await openSummary(a);
    const earlier = await a.getByTestId('export-text').inputValue();
    const downloads = countDownloads(a);

    await holdNextRead(a);
    await recordForItem(b, 'Chair', 'Confirm money received', '30');
    const afterB = await storedRaw(b);
    await waitForHeldRead(a); // A has received the event; its read is held
    await expectLockedWhileChecking(a, 'summary');
    await a.getByRole('button', { name: 'Download text' }).click({ force: true });
    await expect(a.getByTestId('export-text')).toHaveValue(earlier); // the preview is not replaced
    // The dashboard behind the panel has not re-read yet either.
    await expect(itemCard(a, 'Chair').getByTestId('item-net')).toHaveText('$25.00');

    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'changed');
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$55\.00/);
    const file = await downloadVia(a, 'Download text');
    expect(file.text).toContain('Confirmed net received: $55.00');
    expect(file.text).toBe(await a.getByTestId('export-text').inputValue());
    expect(downloads.count).toBe(1);
    expect(await storedRaw(a)).toEqual(afterB);
  });

  test('ready summary, deletion: the deleted case is never exportable while or after the read resolves', async ({ session }) => {
    const { a, b } = await twoDashboards(session, 'EVT-DEL');
    await openSummary(a);
    const downloads = countDownloads(a);

    await holdNextRead(a);
    await b.getByRole('button', { name: 'Delete case…' }).click();
    await b.getByRole('button', { name: 'Permanently delete' }).click();
    await waitForHeldRead(a);
    await expectLockedWhileChecking(a, 'summary');

    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'deleted');
    await expect(a.getByTestId('export-stale')).toContainText('deleted from saved data');
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(a.getByTestId('export-missing')).toContainText('no longer exists in saved data');
    expect(downloads.count).toBe(0);
  });

  test('ready JSON confirmation: Download JSON is blocked before the read resolves; the refreshed file is complete', async ({ session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'EVT-JSON-1', items: [{ label: 'Desk', amount: '80' }] });
    await a.getByRole('button', { name: '← All cases' }).click();
    const b = await session.openDashboard();
    await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
    await expect(a.getByTestId('export-real-count')).toHaveText('1');
    const downloads = countDownloads(a);

    await holdNextRead(a);
    await createCase(b, { orderRef: 'EVT-JSON-2', items: [{ label: 'Shelf', amount: '20' }] });
    const afterB = await storedRaw(b);
    await waitForHeldRead(a);
    await expectLockedWhileChecking(a, 'backup');
    await expect(a.getByTestId('export-real-count')).toHaveText('1'); // the snapshot is unchanged, just locked

    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'changed');
    await a.getByRole('button', { name: 'Refresh snapshot' }).click();
    await expect(a.getByTestId('export-real-count')).toHaveText('2');
    const backup = JSON.parse((await downloadVia(a, 'Download JSON')).text);
    expect(backup.store).toEqual(afterB);
    expect(backup.store.cases).toHaveLength(2);
    expect(downloads.count).toBe(1);
    expect(await storedRaw(a)).toEqual(afterB);
  });

  test('a real copy settling during revalidation names the earlier, unverified snapshot and its details choice', async ({ session }) => {
    const { a, b } = await twoDashboards(session, 'EVT-CLIP');
    await recordForItem(a, 'Chair', 'Confirm money received', '1', { note: 'PRIVATE-EVT-NOTE' });
    await openSummary(a);
    await a.getByLabel(/Include evidence details/).check();
    const withNote = await a.getByTestId('export-text').inputValue();
    expect(withNote).toContain('Note: PRIVATE-EVT-NOTE');

    await gateClipboard(a);
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForPendingCopy(a); // the real write has happened; completion is held
    await holdNextRead(a);
    await recordForItem(b, 'Chair', 'Confirm money received', '30');
    const afterB = await storedRaw(b);
    await waitForHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'checking');

    await settleClipboard(a, 'resolve'); // completes while revalidation is still held
    const feedback = a.getByTestId('export-feedback');
    await expect(feedback).toContainText('Copied the earlier, unverified snapshot shown below (evidence details included)');
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'checking');
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    await expect(a.getByLabel(/Include evidence details/)).toBeDisabled();
    await expect(a.getByLabel(/Include evidence details/)).toBeChecked();
    await expect(a.getByTestId('export-text')).toHaveValue(withNote);
    expect(await pasteClipboard(a)).toBe(withNote);

    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'changed');
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    expect(await storedRaw(a)).toEqual(afterB);
  });

  test('an unrelated change re-enables only after the latest read; a failed or older read never does', async ({ session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'EVT-X', items: [{ label: 'Chair', amount: '100' }] });
    await recordForItem(a, 'Chair', 'Confirm money received', '25');
    await a.getByRole('button', { name: '← All cases' }).click();
    await createCase(a, { orderRef: 'EVT-Y', items: [{ label: 'Lamp', amount: '40' }] });
    await a.getByRole('button', { name: '← All cases' }).click();
    await a.getByTestId('case-row').filter({ hasText: 'EVT-X' }).click();
    const b = await openCaseIn(session, 'EVT-Y');
    await openSummary(a);
    const earlier = await a.getByTestId('export-text').inputValue();

    // 1. A change to another case: locked while checking, re-enabled once the latest read proves case X unchanged.
    await holdNextRead(a);
    await recordForItem(b, 'Lamp', 'Confirm money received', '5');
    await waitForHeldRead(a);
    await expectLockedWhileChecking(a, 'summary');
    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    await expect(a.getByRole('button', { name: 'Download text' })).toBeEnabled();
    await expect(a.getByTestId('export-text')).toHaveValue(earlier);
    expect((await downloadVia(a, 'Download text')).text).toBe(earlier);

    // 2. Successive changes: the first read (X unchanged) is held, the second read fails.
    await holdNextRead(a);
    await recordForItem(b, 'Lamp', 'Confirm money received', '5');
    await waitForHeldRead(a);
    await overridePageReads(a, 'reject');
    await b.getByRole('button', { name: '← All cases' }).click();
    await b.getByTestId('case-row').filter({ hasText: 'EVT-X' }).click();
    await recordForItem(b, 'Chair', 'Confirm money received', '30');
    const afterB = await storedRaw(b);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'unverified');
    // The older held read (which would show X unchanged) is released late: it must not restore currentness.
    await releaseHeldRead(a);
    await expect(a.getByTestId('export-stale')).toHaveAttribute('data-freshness', 'unverified');
    await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
    await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
    await expect(a.getByTestId('export-text')).toHaveValue(earlier);

    // Recovery once reads work again.
    await overridePageReads(a, 'real');
    await a.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(a.getByTestId('export-stale')).toHaveCount(0);
    await expect(a.getByTestId('export-text')).toHaveValue(/Confirmed net received: \$55\.00/);
    const file = await downloadVia(a, 'Download text');
    expect(file.text).toBe(await a.getByTestId('export-text').inputValue());
    expect(await storedRaw(a)).toEqual(afterB);
  });
});
