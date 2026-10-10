// Case summaries and the JSON data export, through the built extension's real
// dashboard, real chrome.storage.local, real clipboard and real browser
// downloads. Failures are injected only from this test code.

import type { Page } from '@playwright/test';
import { createCase, expect, itemCard, recordForItem, test, type ExtensionSession } from './fixtures';
import { BACKUP_FILE, SUMMARY_FILE, countDownloads, downloadVia, openSummary, overridePageReads, pasteClipboard, seed, storedRaw } from './export-helpers';
import { CAPTURE_SOURCE, parseStore } from '../../src/domain/validate';
import { analyzeExcerpt } from '../../src/capture/parse';
import type { RecordEntryCommand } from '../../src/domain/types';
import { Harness } from '../unit/helpers';

test('acceptance 1 and 7: the previewed, copied and downloaded summary keep B’s $35 unresolved expectation; nothing is written', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: '111-2223334-5556667', items: [{ label: 'Blue kettle', amount: '35' }, { label: 'Red mug', amount: '35' }] });
  await recordForItem(page, 'Blue kettle', 'Confirm money received', '35');
  const before = await storedRaw(page);
  const downloads = countDownloads(page);

  await openSummary(page);
  // Opening a preview never copies or downloads anything by itself.
  expect(downloads.count).toBe(0);
  const preview = await page.getByTestId('export-text').inputValue();
  expect(preview).toContain('Order reference: 111-2223334-5556667');
  expect(preview).toMatch(/Item 2: Red mug\n[\s\S]*?Unresolved expected amount: \$35\.00 \(a difference in these records, not a proven amount owed\)/);
  expect(preview).toContain('does not establish that no money arrived');
  await expect(page.getByTestId('export-snapshot')).toContainText('revision 2');

  await page.getByRole('button', { name: 'Copy text' }).click();
  await expect(page.getByTestId('export-feedback')).toHaveText('Copied the summary text shown below (evidence details omitted) to the clipboard.');
  expect(await pasteClipboard(page)).toBe(preview);

  const file = await downloadVia(page, 'Download text');
  expect(file.name).toMatch(SUMMARY_FILE);
  expect(file.text).toBe(preview);
  await expect(page.getByTestId('export-feedback')).toContainText(`Download requested: ${file.name}`);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Prepare case summary…' })).toBeFocused();
  expect(await storedRaw(page)).toEqual(before);

  // An excess on A cannot settle B.
  await recordForItem(page, 'Blue kettle', 'Confirm money received', '35');
  await openSummary(page);
  const after = (await downloadVia(page, 'Download text')).text;
  expect(after).toMatch(/Item 1: Blue kettle\n[\s\S]*?Excess over expected: \$35\.00/);
  expect(after).toMatch(/Item 2: Red mug\n[\s\S]*?Unresolved expected amount: \$35\.00/);
  expect(after).toContain('Status in these records: Needs review');
});

test('acceptance 2 and 3: issued snapshots stay unconfirmed and unsummed; a voided recharge stays as marked history', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Headphones', amount: '70' }] });
  await recordForItem(page, 'Headphones', 'Record merchant report', '70');
  await recordForItem(page, 'Headphones', 'Record merchant report', '70');
  await openSummary(page);
  let text = (await downloadVia(page, 'Download text')).text;
  expect(text).toContain('Status: Merchant reports issued; receipt not confirmed');
  expect(text).toContain('Latest active merchant-issued snapshot: $70.00 (merchant statement, not a receipt confirmation)');
  expect(text).toContain('Receipts confirmed by user: $0.00');
  expect(text).toContain('2 merchant reports are recorded for this item. They are status snapshots and are not added together');
  expect(text).not.toContain('$140.00');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('export-panel')).toHaveCount(0);

  await page.getByRole('button', { name: '← All cases' }).click();
  await createCase(page, { items: [{ label: 'Jacket', amount: '70' }] });
  await recordForItem(page, 'Jacket', 'Confirm money received', '70');
  await recordForItem(page, 'Jacket', 'Record recharge', '20');
  await openSummary(page);
  text = (await downloadVia(page, 'Download text')).text;
  expect(text).toContain('Confirmed net received: $50.00');
  expect(text).toContain('Unresolved expected amount: $20.00');
  await page.getByRole('button', { name: 'Close' }).click();

  const rechargeRow = page.getByTestId('timeline-entry').filter({ hasText: 'You recorded a $20.00 recharge' });
  await rechargeRow.getByRole('button', { name: /^Void/ }).click();
  await page.getByLabel('Why is this entry mistaken?').fill('Different order');
  await page.getByRole('button', { name: 'Void entry' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Settled');
  await openSummary(page);
  text = (await downloadVia(page, 'Download text')).text;
  expect(text).toContain('Confirmed net received: $70.00');
  expect(text).toContain('Recharges recorded: $0.00');
  expect(text).toContain('3. Recharge [VOIDED by entry 4 — kept as history, excluded from current totals]');
  expect(text).toContain('Voided entry 3 (recharge of $20.00)');
  expect(text).toContain('Void reason: [omitted]');
});

test('acceptance 4: a contradictory snapshot keeps review at zero difference; unknown amounts and dates stay unknown', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Coat', amount: '70' }, { label: 'Lamp', unknown: true }] });
  await recordForItem(page, 'Coat', 'Confirm money received', '70');
  await recordForItem(page, 'Coat', 'Record merchant report', '35');
  await openSummary(page);
  const text = (await downloadVia(page, 'Download text')).text;
  expect(text).toMatch(/Item 1: Coat\n {2}Status: Confirmed net received equals expected refund — needs review\n/);
  expect(text).toContain('Difference: $0.00');
  expect(text).toContain('the zero difference does not resolve it');
  expect(text).toContain('Status in these records: Needs review');
  expect(text).toMatch(/Item 2: Lamp\n[\s\S]*?Difference: Unknown — the expected refund is unknown, so the difference cannot be calculated\./);
  expect(text).toContain('Occurred: not given');
  expect(text).not.toMatch(/Occurred: \d/);
});

test('acceptance 5: details are opt-in, the preview updates before export, and hostile text stays literal', async ({ session }) => {
  const page = await session.openDashboard();
  const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>../../evil';
  await createCase(page, { orderRef: '"><svg onload=alert(1)>', items: [{ label: hostile, amount: '50' }] });
  await recordForItem(page, hostile, 'Confirm money received', '20', { reference: 'TXN-PRIVATE-77', note: '<a href="javascript:alert(1)">private note</a>' });
  await openSummary(page);

  const off = await page.getByTestId('export-text').inputValue();
  expect(off).not.toContain('TXN-PRIVATE-77');
  expect(off).not.toContain('private note');
  expect(off).toContain('Reference: [omitted]');
  expect(off).toContain('Unresolved expected amount: $30.00');
  expect(off).toContain(`Item 1: ${hostile}`);
  const offFile = await downloadVia(page, 'Download text');
  expect(offFile.text).toBe(off);
  expect(offFile.name).toMatch(SUMMARY_FILE);

  await page.getByLabel('Include evidence details (notes, transaction references and captured excerpts)').check();
  const on = await page.getByTestId('export-text').inputValue();
  expect(on).toContain('Reference: TXN-PRIVATE-77');
  expect(on).toContain('Note: <a href="javascript:alert(1)">private note</a>');
  await page.getByRole('button', { name: 'Copy text' }).click();
  await expect(page.getByTestId('export-feedback')).toHaveText('Copied the summary text shown below (evidence details included) to the clipboard.');
  expect(await pasteClipboard(page)).toBe(on);
  const onFile = await downloadVia(page, 'Download text');
  expect(onFile.text).toBe(on);
  expect(onFile.name).toMatch(SUMMARY_FILE);

  await expect(page.locator('#app img, #app script, #app svg, #app a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // Unticking restores exactly the default text from the same snapshot.
  await page.getByLabel(/Include evidence details/).uncheck();
  await expect(page.getByTestId('export-text')).toHaveValue(off);
});

test('acceptance 6: clipboard rejection and a failed fresh read give truthful feedback and change nothing; drafts survive', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'FAIL-1', items: [{ label: 'Toaster', amount: '40' }] });
  // An unsaved draft in progress.
  await itemCard(page, 'Toaster').getByRole('button', { name: 'Confirm money received' }).click();
  await page.getByTestId('entry-form').getByRole('textbox', { name: /USD/ }).fill('12.34');
  const before = await storedRaw(page);
  const downloads = countDownloads(page);

  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
  });
  await openSummary(page);
  await page.getByRole('button', { name: 'Copy text' }).click();
  const feedback = page.getByTestId('export-feedback');
  await expect(feedback).toContainText('The text was not copied');
  await expect(feedback).not.toContainText('Copied the summary');
  // The preview stays selectable and is selected for manual copying.
  const textArea = page.getByTestId('export-text');
  await expect(textArea).toBeFocused();
  const selected = await textArea.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(selected).toBe(await textArea.inputValue());
  await page.getByRole('button', { name: 'Close' }).click();

  // A fresh read that fails blocks the export; nothing is substituted.
  await overridePageReads(page, 'reject');
  await page.getByRole('button', { name: 'Prepare case summary…' }).click();
  await expect(page.getByTestId('export-blocked')).toContainText('a valid snapshot of saved data cannot be read');
  await expect(page.getByTestId('export-blocked')).toContainText('Simulated read failure');
  await expect(page.getByRole('button', { name: 'Download text' })).toHaveCount(0);
  await expect(page.getByTestId('export-text')).toHaveCount(0);
  await overridePageReads(page, 'real');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('export-text')).toHaveValue(/Order reference: FAIL-1/);
  await page.getByRole('button', { name: 'Close' }).click();

  expect(downloads.count).toBe(0);
  expect(await storedRaw(page)).toEqual(before);
  // The unsaved draft is still there, and still saves normally.
  const amount = page.getByTestId('entry-form').getByRole('textbox', { name: /USD/ });
  await expect(amount).toHaveValue('12.34');
  await page.getByTestId('entry-form').getByRole('button', { name: 'Save' }).click();
  await expect(itemCard(page, 'Toaster').getByTestId('item-net')).toHaveText('$12.34');
});

function captureEntry(id: string, itemId: string, excerpt: string, parserVersion?: string): RecordEntryCommand['entry'] {
  const a = analyzeExcerpt(excerpt);
  if (!a.issued) throw new Error('fixture must parse');
  return {
    id,
    kind: 'merchant_report',
    itemId,
    amountCents: a.issued.cents,
    occurredOn: a.date.status === 'found' ? a.date.value : null,
    source: CAPTURE_SOURCE,
    note: '',
    reference: null,
    capture: {
      sourceOrigin: 'https://www.amazon.com',
      sourcePath: '/gp/your-account/order-details',
      capturedAt: '2026-10-01T12:00:00.000Z',
      excerpt: a.excerpt,
      parserVersion: parserVersion ?? a.parserVersion,
      approvedAmountText: a.issued.amountText,
      detectedOrderRef: a.orderRef.status === 'found' ? a.orderRef.value : null,
      itemApplicabilityConfirmed: true,
    },
  };
}

/** A SYNTHETIC store with manual records, current and historical captures, voids, unknowns and demo cases. */
function richSeed(): unknown {
  const h = new Harness();
  h.createCase('real-1', [{ id: 'a', label: 'Synthetic kettle', expected: 3500 }, { id: 'b', label: 'Synthetic lamp', expected: null }], '112-1234567-7654321');
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'r1', kind: 'receipt', itemId: 'a', amountCents: 3500, occurredOn: '2026-09-02', source: 'Manual confirmation', note: 'seen on card', reference: 'STMT-1' } });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'x1', kind: 'recharge', itemId: 'a', amountCents: 1000, occurredOn: null, source: 'Manual entry', note: '', reference: null } });
  h.must({ type: 'voidEntry', caseId: 'real-1', voidEntryId: 'v1', targetEntryId: 'x1', reason: 'Different order' });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: captureEntry('cap-new', 'a', 'Order # 112-1234567-7654321\nRefund issued: $35.00') });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'e2', kind: 'expectation', itemId: 'b', amountCents: 1200, occurredOn: null, source: 'Manual entry', note: '', reference: null } });
  h.must({ type: 'recordEntry', caseId: 'real-1', entry: { id: 'e3', kind: 'expectation', itemId: 'b', amountCents: null, occurredOn: null, source: 'Manual entry', note: 'not sure any more', reference: null } });
  h.must({ type: 'loadDemo' });
  const raw = JSON.parse(JSON.stringify(h.store));
  // A capture written by the previous parser version stays valid as stored.
  raw.cases[0].entries.push({ ...captureEntry('cap-old', 'a', 'Refund issued: $35.00', 'amazon-us-selection-1'), recordedAt: '2026-10-02T00:00:00.000Z' });
  return raw;
}

test('acceptance 8: the downloaded JSON envelope validates with parseStore and preserves every record', async ({ session }) => {
  let page = await session.openDashboard();
  const seeded = richSeed();
  await seed(page, seeded);
  await page.close();
  page = await session.openDashboard();
  await expect(page.getByTestId('case-row')).toHaveCount(3);
  const before = await storedRaw(page);
  expect(before).toEqual(seeded);

  await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(page.getByRole('heading', { name: 'Download all data (JSON)' })).toBeFocused();
  await expect(page.getByTestId('export-real-count')).toHaveText('1');
  await expect(page.getByTestId('export-demo-count')).toHaveText('2');
  await expect(page.getByTestId('export-panel')).toContainText('unencrypted');
  await expect(page.getByTestId('export-panel')).toContainText('it can be restored with “Restore from JSON…”');
  await expect(page.getByTestId('export-snapshot')).toContainText(`revision ${(seeded as { revision: number }).revision}`);

  const file = await downloadVia(page, 'Download JSON');
  expect(file.name).toMatch(BACKUP_FILE);
  await expect(page.getByTestId('export-feedback')).toContainText('Download requested');
  const backup = JSON.parse(file.text);
  expect(Object.keys(backup)).toEqual(['format', 'formatVersion', 'exportedAt', 'store']);
  expect(backup.format).toBe('refund-reconciler-backup');
  expect(backup.formatVersion).toBe(1);
  expect(Number.isNaN(Date.parse(backup.exportedAt))).toBe(false);
  // The store is exactly what was saved, and validates unchanged.
  expect(backup.store).toEqual(before);
  const parsed = parseStore(backup.store);
  expect(parsed.status).toBe('ok');
  if (parsed.status === 'ok') expect(JSON.parse(JSON.stringify(parsed.store))).toEqual(backup.store);

  const entries = backup.store.cases.flatMap((c: { entries: Record<string, unknown>[] }) => c.entries);
  expect(entries).toContainEqual(expect.objectContaining({ id: 'r1', reference: 'STMT-1', note: 'seen on card', amountCents: 3500 }));
  expect(entries).toContainEqual(expect.objectContaining({ id: 'x1', kind: 'recharge' }));
  expect(entries).toContainEqual(expect.objectContaining({ id: 'v1', kind: 'void', targetEntryId: 'x1', note: 'Different order' }));
  expect(entries).toContainEqual(expect.objectContaining({ id: 'e3', amountCents: null, note: 'not sure any more' }));
  expect(entries).toContainEqual(expect.objectContaining({ id: 'cap-new', capture: expect.objectContaining({ parserVersion: 'amazon-us-selection-2', excerpt: expect.stringContaining('Refund issued: $35.00') }) }));
  expect(entries).toContainEqual(expect.objectContaining({ id: 'cap-old', capture: expect.objectContaining({ parserVersion: 'amazon-us-selection-1' }) }));
  const demo = backup.store.cases.filter((c: { isDemo: boolean }) => c.isDemo);
  expect(demo).toHaveLength(2);
  expect(demo[0].items[0].label).toContain('(demo)');

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Download all data (JSON)…' })).toBeFocused();
  expect(await storedRaw(page)).toEqual(before);
});

async function openCaseIn(session: ExtensionSession, orderRef: string): Promise<Page> {
  const page = await session.openDashboard();
  await page.getByTestId('case-row').filter({ hasText: orderRef }).click();
  return page;
}

test('acceptance 9: changes or deletion from another dashboard mark the preview and never mismatch the export', async ({ session }) => {
  const a = await session.openDashboard();
  await createCase(a, { orderRef: 'SNAP-1', items: [{ label: 'Chair', amount: '100' }] });
  const b = await openCaseIn(session, 'SNAP-1');

  await openSummary(a);
  const first = await a.getByTestId('export-text').inputValue();
  expect(first).toContain('Receipts confirmed by user: $0.00');

  await recordForItem(b, 'Chair', 'Confirm money received', '30');
  await expect(a.getByTestId('export-stale')).toContainText('changed after this preview was made');
  await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
  await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
  // The visible text is still the earlier snapshot; it is not silently swapped.
  await expect(a.getByTestId('export-text')).toHaveValue(first);

  await a.getByRole('button', { name: 'Refresh preview' }).click();
  await expect(a.getByTestId('export-stale')).toHaveCount(0);
  const second = await a.getByTestId('export-text').inputValue();
  expect(second).toContain('Receipts confirmed by user: $30.00');
  const file = await downloadVia(a, 'Download text');
  expect(file.text).toBe(second);

  // The data export snapshot is marked too.
  await b.getByRole('button', { name: '← All cases' }).click();
  await b.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(b.getByRole('button', { name: 'Download JSON' })).toBeEnabled();
  await recordForItem(a, 'Chair', 'Confirm money received', '5');
  await expect(b.getByTestId('export-stale')).toBeVisible();
  await expect(b.getByRole('button', { name: 'Download JSON' })).toBeDisabled();
  await b.getByRole('button', { name: 'Refresh snapshot' }).click();
  const backup = JSON.parse((await downloadVia(b, 'Download JSON')).text);
  expect(backup.store).toEqual(await storedRaw(b));
  await b.getByRole('button', { name: 'Close' }).click();

  // Deletion in B while A's preview is open.
  await openSummary(a);
  await b.getByTestId('case-row').filter({ hasText: 'SNAP-1' }).click();
  await b.getByRole('button', { name: 'Delete case…' }).click();
  await b.getByRole('button', { name: 'Permanently delete' }).click();
  await expect(a.getByTestId('export-stale')).toContainText('deleted from saved data');
  await expect(a.getByRole('button', { name: 'Copy text' })).toBeDisabled();
  await expect(a.getByRole('button', { name: 'Download text' })).toBeDisabled();
  await a.getByRole('button', { name: 'Refresh preview' }).click();
  await expect(a.getByTestId('export-missing')).toContainText('no longer exists in saved data');
  await expect(a.getByTestId('export-text')).toHaveCount(0);
});

test('acceptance 10: corrupt, unsupported and failed-read storage never produce an export; re-reading recovers without writing', async ({ session }) => {
  let page = await session.openDashboard();
  await createCase(page, { orderRef: 'KEEP-1', items: [{ label: 'Vase', amount: '15' }] });
  await page.getByRole('button', { name: '← All cases' }).click();
  const good = await storedRaw(page);
  const downloads = countDownloads(page);

  // A fresh read that fails validation blocks the data export.
  await overridePageReads(page, 'corrupt');
  await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(page.getByTestId('export-blocked')).toContainText('could not be read');
  await expect(page.getByRole('button', { name: 'Download JSON' })).toHaveCount(0);
  await overridePageReads(page, 'reject');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('export-blocked')).toContainText('Simulated read failure');
  await overridePageReads(page, 'real');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('export-real-count')).toHaveText('1');
  const recovered = JSON.parse((await downloadVia(page, 'Download JSON')).text);
  expect(recovered.store).toEqual(good);
  expect(downloads.count).toBe(1);
  expect(await storedRaw(page)).toEqual(good);
  await page.getByRole('button', { name: 'Close' }).click();

  // Corrupt and unsupported stored data: no export entry point, nothing reset or overwritten.
  for (const bad of [
    { schemaVersion: 1, revision: 1, cases: [{ id: 'c', amountCents: 1.5 }] },
    { schemaVersion: 99, revision: 5, cases: [] },
  ]) {
    await seed(page, bad);
    await page.close();
    page = await session.openDashboard();
    const noDownloads = countDownloads(page);
    await expect(page.getByTestId('vault-unreadable')).toBeVisible();
    await expect(page.getByTestId('export-unavailable')).toContainText('a valid snapshot of saved data cannot be read');
    await expect(page.getByRole('button', { name: 'Download all data (JSON)…' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Prepare case summary…' })).toHaveCount(0);
    expect(noDownloads.count).toBe(0);
    expect(await storedRaw(page)).toEqual(bad);
  }
});
