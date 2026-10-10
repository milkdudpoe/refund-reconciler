// Task 05: the dashboard overview and case finder, through the built
// extension's real dashboard, real service worker messaging, real
// chrome.storage.local events between dashboards and real downloads. All data
// is synthetic; page read faults are injected from this test code only.

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { createCase, expect, recordForItem, test } from './fixtures';
import { overridePageReads, seed, storedRaw } from './export-helpers';
import { approveButton, chooseBackup, envelopeOf, expectEligible, openRestore, scratchDir, writeBackupFile } from './restore-helpers';
import { MIXED_TOTALS, mixedLedger } from '../shared/overview-ledger';

const search = (p: Page) => p.getByLabel('Search by order reference or item description');
const statusFilter = (p: Page) => p.getByLabel('Status', { exact: true });
const rows = (p: Page) => p.getByTestId('real-cases').getByTestId('case-row');
const row = (p: Page, text: string) => rows(p).filter({ hasText: text });

function mixedRaw(): { revision: number; cases: unknown[] } {
  return JSON.parse(JSON.stringify(mixedLedger().store)) as { revision: number; cases: unknown[] };
}

async function expectOverview(p: Page, o: { unresolved: string; unknown: number; attention: number; review: number; cases: number }): Promise<void> {
  await expect(p.getByRole('heading', { name: `Overview of all ${o.cases} cases you saved` })).toBeVisible();
  await expect(p.getByTestId('overview-unresolved')).toHaveText(o.unresolved);
  await expect(p.getByTestId('overview-unknown')).toHaveText(String(o.unknown));
  await expect(p.getByTestId('overview-attention')).toHaveText(String(o.attention));
  await expect(p.getByTestId('overview-review')).toHaveText(String(o.review));
}

const MIXED = { unresolved: '$140.00', unknown: MIXED_TOTALS.unknownItemCount, attention: MIXED_TOTALS.attentionCount, review: MIXED_TOTALS.reviewCount, cases: MIXED_TOTALS.caseCount };

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
    wrap(rt, 'sendMessage', 'sendMessage');
    for (const k of ['set', 'remove', 'clear'] as const) wrap(area, k, `storage.${k}`);
  });
}

async function writes(p: Page): Promise<string[]> {
  return p.evaluate(() => (window as unknown as { __writes: string[] }).__writes);
}

async function caret(p: Page): Promise<[number | null, number | null]> {
  return search(p).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
}

test('acceptance 1, 4: keyboard search and status persist through case detail and live changes from another dashboard', async ({ session }) => {
  const a = await session.openDashboard();
  await seed(a, mixedRaw());
  await expectOverview(a, MIXED);
  await expect(a.getByTestId('overview')).toContainText('Synthetic demo cases are not included');
  await expect(a.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
  // A fresh dashboard starts at All with an empty query, newest first.
  await expect(search(a)).toHaveValue('');
  await expect(statusFilter(a)).toHaveValue('all');
  await expect(a.getByTestId('results-count')).toHaveText('Showing all 7 cases');
  await expect(rows(a)).toHaveCount(7);
  await expect(rows(a).first()).toContainText('Order 111-0000007-0000007');
  await expect(row(a, '111-0000007')).toContainText('1 item to review: merchant report conflicts with confirmed receipts');
  await expect(row(a, '111-0000007')).toContainText('Unresolved $0.00');

  // Ordinary keyboard typing and selection.
  await search(a).click();
  await a.keyboard.type('RAIN');
  await expect(search(a)).toBeFocused();
  await expect(search(a)).toHaveValue('RAIN');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toContainText('Order 111-0000005-0000005');
  await expect(a.getByTestId('results-count')).toHaveText('Showing 1 of 7 cases');
  await expect(a.locator('#status')).toHaveText('1 of 7 cases shown.');
  await a.keyboard.press('Tab');
  await expect(statusFilter(a)).toBeFocused();
  await statusFilter(a).selectOption('review');
  await expect(rows(a)).toHaveCount(1);
  await statusFilter(a).selectOption('settled');
  await expect(a.getByTestId('no-matches')).toContainText('No cases match this search and status.');
  await expect(a.getByTestId('no-matches')).toContainText('Your 7 saved cases are unchanged');
  await expect(a.getByRole('button', { name: /Restore from a JSON backup/ })).toHaveCount(0);
  await expect(a.getByTestId('empty-state')).toHaveCount(0);
  // The overview is still for all cases, not the filtered view.
  await expectOverview(a, MIXED);
  await statusFilter(a).selectOption('attention');
  await expect(rows(a)).toHaveCount(1);

  // Open the matching case and come back: controls and results are kept.
  await rows(a).click();
  await expect(a.getByRole('heading', { name: /Order 111-0000005-0000005/ })).toBeFocused();
  await a.getByRole('button', { name: '← All cases' }).click();
  await expect(search(a)).toHaveValue('RAIN');
  await expect(statusFilter(a)).toHaveValue('attention');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toBeFocused();

  // Caret in the middle of the query, then another dashboard saves a matching case.
  await search(a).click();
  await a.keyboard.press('End');
  await a.keyboard.press('ArrowLeft');
  await a.keyboard.press('ArrowLeft');
  expect(await caret(a)).toEqual([2, 2]);
  const b = await session.openDashboard();
  await createCase(b, { orderRef: 'NEW-RAIN-1', items: [{ label: 'Rain boots', amount: '45' }] });
  await expect(b.getByTestId('notice')).toHaveText('Case saved.');
  await expect(rows(a)).toHaveCount(2);
  await expect(rows(a).first()).toContainText('Order NEW-RAIN-1');
  // A is a background tab now, so check its active element directly, then bring it back.
  expect(await a.evaluate(() => document.activeElement?.id)).toBe('case-search');
  await expect(search(a)).toHaveValue('RAIN');
  expect(await caret(a)).toEqual([2, 2]);
  await a.bringToFront();
  await expect(search(a)).toBeFocused();
  expect(await caret(a)).toEqual([2, 2]);
  await expectOverview(a, { ...MIXED, cases: 8, attention: 7, unresolved: '$185.00' });

  // Keep typing while the other dashboard records evidence: nothing typed is lost.
  await a.keyboard.press('End');
  await Promise.all([
    a.keyboard.type(' boots', { delay: 60 }),
    (async () => {
      await recordForItem(b, 'Rain boots', 'Record merchant report', '45');
      await recordForItem(b, 'Rain boots', 'Confirm money received', '45');
    })(),
  ]);
  await expect(search(a)).toHaveValue('RAIN boots');
  await expect(search(a)).toBeFocused();
  // The receipt settled the new case, so it leaves Needs attention.
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await expectOverview(a, { ...MIXED, cases: 8 });
  await statusFilter(a).selectOption('settled');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toContainText('Order NEW-RAIN-1');

  // Clear filters returns to everything and focuses the search field.
  await a.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(search(a)).toHaveValue('');
  await expect(search(a)).toBeFocused();
  await expect(statusFilter(a)).toHaveValue('all');
  await expect(rows(a)).toHaveCount(8);
});

test('a narrow 360px dashboard keeps search, status and Clear filters reachable by vertical scrolling without horizontal overflow', async ({ session }) => {
  const a = await session.openDashboard();
  await a.setViewportSize({ width: 360, height: 720 });
  await seed(a, mixedRaw());
  await expectOverview(a, MIXED);
  await expect(rows(a)).toHaveCount(7);

  const noHorizontalOverflow = () => a.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  /** The control's box lies within the viewport's width (it may be anywhere vertically). */
  const fitsHorizontally = async (locator: ReturnType<typeof search>) => {
    const box = await locator.boundingBox();
    const width = await a.evaluate(() => document.documentElement.clientWidth);
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  };
  expect(await noHorizontalOverflow()).toBe(true);

  // Search: scrolled into view by normal vertical scrolling, then typed with the keyboard.
  await search(a).scrollIntoViewIfNeeded();
  await expect(search(a)).toBeInViewport();
  await fitsHorizontally(search(a));
  await search(a).focus();
  await a.keyboard.type('Rain (');
  await expect(search(a)).toHaveValue('Rain (');
  await expect(a.getByTestId('no-matches')).toBeVisible(); // "(" is literal, not a pattern
  await a.keyboard.press('Backspace');
  await a.keyboard.press('Backspace');
  await expect(search(a)).toHaveValue('Rain');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toContainText('Order 111-0000005-0000005');
  await expect(a.getByTestId('results-count')).toHaveText('Showing 1 of 7 cases');
  expect(await noHorizontalOverflow()).toBe(true);

  // Status: combined with the search.
  await statusFilter(a).scrollIntoViewIfNeeded();
  await expect(statusFilter(a)).toBeInViewport();
  await fitsHorizontally(statusFilter(a));
  await statusFilter(a).selectOption('settled');
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await statusFilter(a).selectOption('review');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toContainText('Order 111-0000005-0000005');
  await search(a).scrollIntoViewIfNeeded();
  await search(a).fill('');
  await search(a).focus();
  await a.keyboard.type('111-');
  await expect(rows(a)).toHaveCount(3);
  // The overview stays the evidence-based total for all cases.
  await expectOverview(a, MIXED);
  expect(await noHorizontalOverflow()).toBe(true);

  // Clear filters: reachable, restores everything and returns focus to the search field.
  const clear = a.locator('#clear-filters');
  await clear.scrollIntoViewIfNeeded();
  await expect(clear).toBeInViewport();
  await fitsHorizontally(clear);
  await clear.click();
  await expect(search(a)).toBeFocused();
  await expect(search(a)).toHaveValue('');
  await expect(statusFilter(a)).toHaveValue('all');
  await expect(rows(a)).toHaveCount(7);
  await expect(a.getByTestId('results-count')).toHaveText('Showing all 7 cases');
  await expect(search(a)).toBeInViewport();

  // The last row and the demo section are still reachable by vertical scrolling.
  await rows(a).last().scrollIntoViewIfNeeded();
  await expect(rows(a).last()).toBeInViewport();
  await a.getByTestId('demo-cases').scrollIntoViewIfNeeded();
  await expect(a.getByTestId('demo-cases')).toBeInViewport();
  expect(await noHorizontalOverflow()).toBe(true);
});

test('acceptance 5: settling and re-opening a filtered case, contradictions, demo changes and restore update the overview', async ({ session }) => {
  const a = await session.openDashboard();
  await seed(a, mixedRaw());
  await statusFilter(a).selectOption('attention');
  await search(a).fill('kettle');
  await expect(rows(a)).toHaveCount(1);

  const b = await session.openDashboard();
  await b.getByTestId('case-row').filter({ hasText: '111-0000001' }).click();
  await recordForItem(b, 'Blue Kettle', 'Confirm money received', '15');
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await expectOverview(a, { ...MIXED, unresolved: '$125.00', attention: 5 });
  await statusFilter(a).selectOption('settled');
  await expect(rows(a)).toContainText('Order 111-0000001-0000001');

  // A later recharge reopens it: back in Needs attention and Needs review.
  await recordForItem(b, 'Blue Kettle', 'Record recharge', '5');
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await statusFilter(a).selectOption('review');
  await expect(rows(a)).toHaveCount(1);
  await expect(rows(a)).toContainText('recharge recorded');
  await expectOverview(a, { ...MIXED, unresolved: '$130.00', review: 4 });

  // A settled case with a new, lower merchant report is balanced but contradictory.
  await a.getByRole('button', { name: 'Clear filters' }).click();
  await statusFilter(a).selectOption('review');
  await expect(rows(a)).toHaveCount(4);
  await b.getByRole('button', { name: '← All cases' }).click();
  await b.getByTestId('case-row').filter({ hasText: '111-0000003' }).click();
  await recordForItem(b, 'Desk lamp', 'Record merchant report', '10');
  await expect(rows(a)).toHaveCount(5);
  await expect(row(a, '111-0000003')).toContainText('Unresolved $0.00');
  await expect(row(a, '111-0000003')).toContainText('merchant report conflicts with confirmed receipts');
  await expectOverview(a, { ...MIXED, unresolved: '$130.00', review: 5, attention: 7 });

  // Removing and reloading the synthetic demo never changes real totals or results.
  const overviewText = await a.getByTestId('overview').innerText();
  await b.getByRole('button', { name: '← All cases' }).click();
  await b.getByRole('button', { name: 'Remove synthetic demo' }).click();
  await expect(a.getByTestId('demo-cases')).toHaveCount(0);
  expect(await a.getByTestId('overview').innerText()).toBe(overviewText);
  await expect(rows(a)).toHaveCount(5);
  await b.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(a.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
  expect(await a.getByTestId('overview').innerText()).toBe(overviewText);
  await expect(rows(a)).toHaveCount(5);
  await expect(statusFilter(a)).toHaveValue('review');
});

test('acceptance 5: a restored ledger updates an open dashboard overview without adding or altering evidence', async ({ session }) => {
  const scratch = await scratchDir();
  try {
    const source = mixedRaw();
    const watcher = await session.openDashboard();
    await expect(watcher.getByTestId('overview-empty')).toBeVisible();
    const page = await session.openDashboard();
    await openRestore(page);
    await chooseBackup(page, await writeBackupFile(scratch.dir, 'mixed.json', envelopeOf(source)));
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await expectOverview(watcher, MIXED);
    await expect(rows(watcher)).toHaveCount(7);
    await search(watcher).fill('hose');
    await expect(rows(watcher)).toHaveCount(1);
    await expect(rows(watcher)).toContainText('1 unknown');
    const stored = (await storedRaw(watcher)) as { cases: unknown[] };
    expect(stored.cases).toEqual(source.cases);
  } finally {
    await scratch.cleanup();
  }
});

test('acceptance 6: no real cases, demo only, no matches and unreadable storage are distinct, and recovery is accurate', async ({ session }) => {
  const a = await session.openDashboard();
  // Nothing stored.
  await expect(a.getByTestId('overview-empty')).toHaveText(
    'No cases of your own are saved, so there are no totals to show. This says nothing about whether your actual refunds are settled.',
  );
  await expect(a.getByTestId('empty-state')).toContainText('No cases yet.');
  await expect(a.getByRole('button', { name: 'Restore from a JSON backup…' })).toBeVisible();
  await expect(search(a)).toHaveCount(0);

  // Demo only: still no real totals, demo excluded, no empty-storage restore invitation.
  await a.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(a.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
  await expect(a.getByTestId('overview-empty')).toContainText('Synthetic demo cases are never included in these totals.');
  await expect(a.getByTestId('overview-unresolved')).toHaveCount(0);
  await expect(a.getByTestId('empty-state')).toBeVisible();
  await expect(a.getByRole('button', { name: 'Restore from a JSON backup…' })).toHaveCount(0);
  await expect(search(a)).toHaveCount(0);

  // Real cases with a search that matches nothing.
  await seed(a, mixedRaw());
  await search(a).fill('no such order');
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await expect(a.getByTestId('empty-state')).toHaveCount(0);
  await expectOverview(a, MIXED);

  // Corrupt, then unsupported, storage: no overview, no totals, no empty state.
  await seed(a, { schemaVersion: 1, revision: 3, cases: [{ id: 'broken' }] });
  await expect(a.getByTestId('vault-unreadable')).toBeVisible();
  await expect(a.getByTestId('overview')).toHaveCount(0);
  await expect(a.getByTestId('empty-state')).toHaveCount(0);
  await expect(a.getByTestId('no-matches')).toHaveCount(0);
  await seed(a, { schemaVersion: 99, revision: 1, cases: [] });
  await expect(a.getByRole('heading', { name: 'Your encrypted records use an unsupported version' })).toBeVisible();
  await expect(a.getByTestId('overview')).toHaveCount(0);

  // Valid data again: genuine recovery, with the earlier search still applied.
  const fixed = mixedRaw();
  await seed(a, fixed);
  await expectOverview(a, MIXED);
  await expect(search(a)).toHaveValue('no such order');
  await expect(a.getByTestId('no-matches')).toBeVisible();

  // A failed read after a change elsewhere: an error, not old totals or an empty ledger.
  const b = await session.openDashboard();
  await overridePageReads(a, 'reject');
  await createCase(b, { orderRef: 'AFTER-FAIL', items: [{ label: 'Doormat', amount: '12' }] });
  await expect(a.getByTestId('storage-error')).toBeVisible();
  await expect(a.getByTestId('overview')).toHaveCount(0);
  await expect(a.getByTestId('empty-state')).toHaveCount(0);
  await overridePageReads(a, 'real');
  await a.getByRole('button', { name: 'Try again' }).click();
  await expectOverview(a, { ...MIXED, cases: 8, attention: 7, unresolved: '$152.00' });
  await a.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(rows(a).first()).toContainText('Order AFTER-FAIL');
});

test('acceptance 7: filtering writes nothing, and the JSON backup still contains all stored data whatever is selected', async ({ session }) => {
  const a = await session.openDashboard();
  const source = mixedRaw();
  await seed(a, source);
  await expectOverview(a, MIXED);
  const before = await storedRaw(a);
  await recordWrites(a);

  await search(a).click();
  await a.keyboard.type('<b>.*(</b>');
  await expect(a.getByTestId('no-matches')).toBeVisible();
  await expect(a.locator('#app b')).toHaveCount(0);
  for (const s of ['attention', 'review', 'settled', 'all']) await statusFilter(a).selectOption(s);
  await a.getByRole('button', { name: 'Clear filters' }).first().click();
  await search(a).fill('desk');
  await statusFilter(a).selectOption('settled');
  await rows(a).click();
  await a.getByRole('button', { name: '← All cases' }).click();
  await search(a).fill('zzz-nothing');
  await expect(a.getByTestId('no-matches')).toBeVisible();

  expect(await writes(a)).toEqual([]);
  expect(await storedRaw(a)).toEqual(before);

  // With a no-match filter active, the backup still has every case, demo and history.
  await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(a.getByTestId('export-real-count')).toHaveText('7');
  await expect(a.getByTestId('export-demo-count')).toHaveText('2');
  const [dl] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  const file = JSON.parse(await readFile(await dl.path(), 'utf8')) as { store: { revision: number; cases: unknown[] } };
  expect(file.store.cases).toEqual(source.cases);
  expect(file.store.revision).toBe(source.revision);
  await a.getByRole('button', { name: 'Close' }).click();
  await expect(search(a)).toHaveValue('zzz-nothing');
  expect(await storedRaw(a)).toEqual(before);
});

test('acceptance 2: an unrepresentable cross-case total is shown as unavailable while every case stays usable', async ({ session }) => {
  const a = await session.openDashboard();
  // A ledger this large exceeds chrome.storage.local's quota, so this page's read replies return it instead
  // (a disclosed fake of the service worker's unlocked read reply; the page still validates it).
  await a.evaluate(() => {
    const max = 100_000_000_000;
    const at = '2026-01-01T00:00:00.000Z';
    const big = (id: string) => {
      const entries: Record<string, unknown>[] = [{ id: `${id}-exp`, kind: 'expectation', itemId: `${id}-i`, amountCents: max, recordedAt: at, occurredOn: null, source: 'Test', note: '' }];
      for (let i = 0; i < 45_036; i++) entries.push({ id: `${id}-x${i}`, kind: 'recharge', itemId: `${id}-i`, amountCents: max, recordedAt: at, occurredOn: null, source: 'Test', note: '', reference: null });
      return { id, retailer: 'amazon_us', orderRef: id, currency: 'USD', isDemo: false, createdAt: at, updatedAt: at, items: [{ id: `${id}-i`, label: 'Synthetic huge item', createdAt: at }], entries };
    };
    const small = { id: 'small', retailer: 'amazon_us', orderRef: 'SMALL-1', currency: 'USD', isDemo: false, createdAt: at, updatedAt: '2026-02-01T00:00:00.000Z', items: [{ id: 'small-i', label: 'Small item', createdAt: at }], entries: [{ id: 'small-exp', kind: 'expectation', itemId: 'small-i', amountCents: 1234, recordedAt: at, occurredOn: null, source: 'Test', note: '' }] };
    const store = { schemaVersion: 1, revision: 9, cases: [big('big-1'), big('big-2'), small] };
    const rt = chrome.runtime as unknown as { sendMessage: (m: unknown) => Promise<unknown> };
    const real = rt.sendMessage.bind(chrome.runtime);
    rt.sendMessage = (m: unknown) => ((m as { kind?: string }).kind === 'read' ? Promise.resolve({ ok: true, ledger: { status: 'ok', isNew: false, vaultId: 'synthetic-vault', store } }) : real(m));
  });
  // Any storage change makes the dashboard re-read.
  await a.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(a.getByTestId('overview-unresolved')).toHaveText('Total unavailable', { timeout: 20_000 });
  await expect(a.getByTestId('overview-unavailable')).toContainText('too large to add up exactly');
  await expect(a.getByTestId('overview-attention')).toHaveText('3');
  await expect(a.getByTestId('overview-review')).toHaveText('2');
  await expect(rows(a)).toHaveCount(3);
  await expect(row(a, 'SMALL-1')).toContainText('Unresolved $12.34');
  await expect(row(a, 'big-1')).toContainText('Unresolved $45,037,000,000,000.00');
  await search(a).fill('small');
  await expect(rows(a)).toHaveCount(1);
  await rows(a).click();
  await expect(a.getByTestId('case-unresolved')).toHaveText('$12.34');
});
