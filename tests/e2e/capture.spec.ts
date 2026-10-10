// Selected-text capture through the real popup, chrome.scripting, the
// service-worker message boundary and chrome.storage.local. Pages are
// SYNTHETIC fixtures (see capture-fixtures.ts), and page access in the
// `granted` session comes from a temporary test copy, not a user gesture.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { DIST, createCase, itemCard, recordForItem } from './fixtures';
import { ORDER_A, ORDER_B, ORDER_PAGE, expect, openPopup, openSource, selectBlock, storedEntries, storedRaw, test } from './capture-fixtures';

async function capture(popup: Page): Promise<void> {
  await popup.getByRole('button', { name: 'Capture selected refund text' }).click();
}

async function assign(popup: Page, caseLabel: string | RegExp, itemLabel: string): Promise<void> {
  const caseSelect = popup.getByLabel('Case', { exact: true });
  const option = await caseSelect.locator('option').filter({ hasText: caseLabel }).first().getAttribute('value');
  await caseSelect.selectOption(option!);
  await popup.getByLabel('Item', { exact: true }).selectOption({ label: itemLabel });
}

async function approveAndSave(popup: Page): Promise<void> {
  await popup.getByRole('checkbox', { name: /is the refund for this one item/ }).check();
  await popup.getByRole('button', { name: 'Save merchant report' }).click();
}

test('production build: only storage, activeTab and scripting; no host access without a user grant', async ({ production }) => {
  const shipped = JSON.parse(await readFile(join(DIST, 'manifest.json'), 'utf8'));
  const source = JSON.parse(await readFile(join(import.meta.dirname, '../../public/manifest.json'), 'utf8'));
  expect(shipped).toEqual(source);
  expect(shipped.permissions).toEqual(['storage', 'activeTab', 'scripting']);
  expect(shipped.host_permissions).toBeUndefined();
  expect(shipped.optional_host_permissions).toBeUndefined();
  expect(shipped.content_scripts).toBeUndefined();
  expect(shipped.action.default_popup).toBe('popup.html');

  const { page, tabId, windowId } = await openSource(production);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(production, windowId);
  const loaded = await popup.evaluate(() => chrome.runtime.getManifest());
  expect(loaded.permissions).toEqual(['storage', 'activeTab', 'scripting']);
  expect(loaded.host_permissions ?? []).toEqual([]);

  // Opening popup.html directly is not a toolbar click, so no activeTab grant exists:
  // the tab's URL is hidden and the real scripting API refuses to inject.
  await capture(popup);
  await expect(popup.getByTestId('capture-failed')).toContainText('has no access to this tab');
  const direct = await popup.evaluate(async (id) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.title });
      return 'injected';
    } catch (err) {
      return `refused: ${(err as Error).message}`;
    }
  }, tabId);
  expect(direct).toMatch(/^refused: /);
  expect(await storedRaw(production)).toBeUndefined();

  // Open dashboard stays available from the toolbar UI.
  const dashPromise = production.context!.waitForEvent('page', (p) => p.url().endsWith('/dashboard.html'));
  await popup.getByRole('button', { name: 'Open dashboard' }).click();
  const dash = await dashPromise;
  await expect(dash.getByRole('heading', { name: 'Your cases' })).toBeVisible();
});

test('$70 issued: previewed without writing, then saved once as an issued/unconfirmed snapshot (acceptance 1)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const before = await storedRaw(granted);

  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(granted, windowId);
  await capture(popup);

  await expect(popup.getByTestId('excerpt')).toHaveText(`Order # ${ORDER_A}\n\nSynthetic headphones\n\nRefund issued: $70.00`);
  await expect(popup.getByTestId('detected-amount')).toHaveText('$70.00 (from “$70.00”)');
  await expect(popup.getByTestId('detected-order')).toHaveText(ORDER_A);
  await expect(popup.getByTestId('detected-date')).toHaveText('Unknown');
  // Tracking path segment, other query parameters and the fragment are dropped.
  await expect(popup.getByTestId('detected-source')).toHaveText(`https://www.amazon.com/gp/your-account/order-details?orderID=${ORDER_A}`);
  expect(await storedRaw(granted)).toEqual(before);

  // No case or item is chosen automatically, and Save stays disabled until both are chosen and confirmed.
  await expect(popup.getByLabel('Case', { exact: true })).toHaveValue('');
  const save = popup.getByRole('button', { name: 'Save merchant report' });
  await expect(save).toBeDisabled();
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic headphones');
  await expect(popup.getByTestId('proposal')).toContainText('does not record money received');
  await expect(save).toBeDisabled();
  await approveAndSave(popup);
  await expect(popup.getByTestId('notice')).toHaveText('Merchant report saved. No receipt was recorded.');
  await expect(popup.getByTestId('capture-saved')).toBeVisible();

  const entries = await storedEntries(granted);
  expect(entries.filter((e) => e.kind === 'receipt' || e.kind === 'recharge')).toHaveLength(0);
  const reports = entries.filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    amountCents: 7000,
    capture: {
      sourceOrigin: 'https://www.amazon.com',
      sourcePath: `/gp/your-account/order-details?orderID=${ORDER_A}`,
      excerpt: `Order # ${ORDER_A}\n\nSynthetic headphones\n\nRefund issued: $70.00`,
      parserVersion: 'amazon-us-selection-1',
      approvedAmountText: '$70.00',
      detectedOrderRef: ORDER_A,
      itemApplicabilityConfirmed: true,
    },
  });
  expect(JSON.stringify(entries)).not.toMatch(/session-id|SYNTHETIC#top|hunter2|ref=ppx/);

  const card = itemCard(dash, 'Synthetic headphones');
  await expect(card.getByTestId('item-status')).toHaveText('Merchant reports issued · receipt unconfirmed');
  await expect(card.getByTestId('item-reported')).toHaveText('$70.00');
  await expect(card.getByTestId('item-net')).toHaveText('$0.00');
  await expect(dash.getByTestId('case-status')).toHaveText('Open');
  const provenance = dash.getByTestId('provenance');
  await expect(provenance).toContainText(`from https://www.amazon.com/gp/your-account/order-details?orderID=${ORDER_A}`);
  await expect(provenance).toContainText('not confirmation that money arrived');
});

test('cancel, empty, editable, oversized, unsupported text/currency, hosts, closure and navigation add nothing (acceptance 2)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const before = await storedRaw(granted);

  const { page, windowId } = await openSource(granted);
  const popup = await openPopup(granted, windowId);
  const failed = popup.getByTestId('capture-failed');

  // Cancel an otherwise valid preview.
  await selectBlock(page, 'issued-70');
  await capture(popup);
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic headphones');
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup.getByTestId('notice')).toHaveText('Capture discarded. Nothing was saved.');

  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await capture(popup);
  await expect(failed).toContainText('No text is selected');

  await page.evaluate(() => (document.getElementById('note-box') as HTMLTextAreaElement).select());
  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(failed).toContainText('inside a form field');

  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await selectBlock(page, 'long');
  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(failed).toContainText('too long (the limit is 4,000 characters). Nothing was read.');

  for (const [block, reason] of [
    ['euro', 'currency other than US dollars'],
    ['estimated', 'No amount is clearly described as issued'],
  ] as const) {
    await selectBlock(page, block);
    await popup.getByRole('button', { name: /Try again|Capture selected refund text/ }).click();
    await expect(popup.getByTestId('unsupported')).toContainText(reason);
    await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
    await popup.getByRole('button', { name: 'Discard' }).click();
  }
  expect(await storedRaw(granted)).toEqual(before);

  // Unsupported hosts and schemes are rejected by the extension's own check (the test copy has access to them).
  for (const [url, reason] of [
    ['https://www.amazon.co.uk/gp/your-account/order-details', 'Other sites and other Amazon country sites are not'],
    ['https://www.amazon.com.evil.example/gp/your-account/order-details', 'Other sites and other Amazon country sites are not'],
    ['http://www.amazon.com/gp/your-account/order-details', 'Only secure (https)'],
  ] as const) {
    const other = await openSource(granted, url);
    await selectBlock(other.page, 'issued-70');
    const p = await openPopup(granted, other.windowId);
    await capture(p);
    await expect(p.getByTestId('capture-failed')).toContainText(reason);
    await p.close();
    await other.page.close();
  }

  // Navigation after the popup opened: the fixed source tab now shows another site.
  const nav = await openSource(granted);
  const navPopup = await openPopup(granted, nav.windowId);
  await nav.page.goto('https://www.amazon.co.uk/gp/your-account/order-details');
  await selectBlock(nav.page, 'issued-70');
  await capture(navPopup);
  await expect(navPopup.getByTestId('capture-failed')).toContainText(/different page|Other sites/);

  // Same-site navigation is fine; leaving to a different Amazon origin is not.
  await nav.page.goto(ORDER_PAGE.replace('https://www.', 'https://'));
  await selectBlock(nav.page, 'issued-70');
  await navPopup.getByRole('button', { name: 'Try again' }).click();
  await expect(navPopup.getByTestId('capture-failed')).toContainText('moved to a different page');

  // Tab closed after the popup opened.
  const closing = await openSource(granted);
  const closingPopup = await openPopup(granted, closing.windowId);
  await selectBlock(closing.page, 'issued-70');
  await closing.page.close();
  await capture(closingPopup);
  await expect(closingPopup.getByTestId('capture-failed')).toContainText('The Amazon tab was closed. Nothing was captured.');

  expect(await storedRaw(granted)).toEqual(before);
});

test('purchase price, pending, multiple and aggregate amounts never become an item-issued amount (acceptance 3)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Synthetic kettle', amount: '35' }, { label: 'Synthetic mug', amount: '35' }] });
  const before = await storedRaw(granted);
  const { page, windowId } = await openSource(granted);
  const popup = await openPopup(granted, windowId);

  for (const [block, reason, notIssued] of [
    ['price-pending', 'No amount is clearly described as issued', ['$80.00: price or total wording', '$70.00: pending wording']],
    ['multiple', 'More than one issued amount was found', []],
    ['aggregate', 'order-level refund total', []],
  ] as const) {
    await selectBlock(page, block);
    await capture(popup);
    const unsupported = popup.getByTestId('unsupported');
    await expect(unsupported).toContainText(reason);
    await expect(popup.getByTestId('detected-amount')).toHaveText('Not found');
    for (const line of notIssued) await expect(popup.getByTestId('not-issued')).toContainText(line);
    await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
    await expect(unsupported.getByRole('button', { name: 'Enter manually in dashboard' })).toBeVisible();
    await popup.getByRole('button', { name: 'Discard' }).click();
  }
  expect(await storedRaw(granted)).toEqual(before);
});

test('equal amounts stay separate; order mismatch and demo cases are blocked; no receipt is created (acceptance 4)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await dash.getByRole('button', { name: 'Load synthetic demo' }).click();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic item A', amount: '35' }, { label: 'Synthetic item B', amount: '35' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { orderRef: ORDER_B, items: [{ label: 'Other order item', amount: '35' }] });

  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-35-order-b');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  // Demo cases are never offered.
  await expect(popup.getByLabel('Case', { exact: true }).locator('option')).toHaveText(['Choose a case…', `Order ${ORDER_A}`, `Order ${ORDER_B}`]);
  // The text names order B; choosing order A's case is flagged and blocked.
  await popup.getByLabel('Case', { exact: true }).selectOption({ label: `Order ${ORDER_A}` });
  await expect(popup.getByTestId('order-mismatch')).toBeVisible();
  await popup.getByLabel('Item', { exact: true }).selectOption({ label: 'Synthetic item A' });
  await popup.getByRole('checkbox', { name: /is the refund for this one item/ }).check();
  await expect(popup.getByRole('button', { name: 'Save merchant report' })).toBeDisabled();
  await popup.getByRole('button', { name: 'Cancel' }).click();

  // An item-specific $35 line with no order number, assigned explicitly to item B.
  await selectBlock(page, 'issued-35');
  await capture(popup);
  await expect(popup.getByTestId('detected-date')).toHaveText('2026-10-03');
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic item B');
  await expect(popup.getByTestId('order-mismatch')).toHaveCount(0);
  await approveAndSave(popup);
  await expect(popup.getByTestId('capture-saved')).toContainText('Synthetic item B');

  const entries = await storedEntries(granted);
  const reports = entries.filter((e) => e.kind === 'merchant_report' && e.capture);
  expect(reports).toHaveLength(1);
  expect(entries.filter((e) => e.id.startsWith('cap-') && e.kind !== 'merchant_report')).toHaveLength(0);
  expect(entries.filter((e) => e.kind === 'receipt' && !e.id.startsWith('demo-'))).toHaveLength(0);

  await dash.getByRole('button', { name: '← All cases' }).click();
  await dash.getByTestId('case-row').filter({ hasText: ORDER_A }).click();
  await expect(itemCard(dash, 'Synthetic item B').getByTestId('item-reported')).toHaveText('$35.00');
  await expect(itemCard(dash, 'Synthetic item A').getByTestId('item-reported')).toHaveText('No report');
  await dash.getByRole('button', { name: '← All cases' }).click();
  await dash.getByTestId('case-row').filter({ hasText: ORDER_B }).click();
  await expect(itemCard(dash, 'Other order item').getByTestId('item-reported')).toHaveText('No report');

  // The service worker refuses captured evidence for a demo case even if asked directly.
  const report = reports[0]!;
  const res = await popup.evaluate(
    ([entry]) => chrome.runtime.sendMessage({ kind: 'mutate', command: { type: 'recordEntry', caseId: 'demo-case-partial', entry: { ...entry, id: 'cap-demo-attempt', itemId: 'demo-item-b' } } }),
    [{ id: report.id, kind: 'merchant_report', itemId: report.itemId, amountCents: report.amountCents, occurredOn: '2026-10-03', source: 'Amazon page selection (captured)', note: '', reference: null, capture: report.capture }] as const,
  );
  expect(res).toMatchObject({ ok: false, error: { message: expect.stringContaining('synthetic demo') } });
});

test('a lost reply and approval retries keep one observation; a rejected write keeps the preview (acceptance 5)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');

  // 1. Rejected write: storage really is full.
  let popup = await openPopup(granted, windowId);
  await popup.evaluate(async () => {
    const quota = chrome.storage.local.QUOTA_BYTES;
    const used = await chrome.storage.local.getBytesInUse(null);
    await chrome.storage.local.set({ filler: 'x'.repeat(quota - used - 'filler'.length - 2 - 64) });
  });
  await capture(popup);
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic headphones');
  await approveAndSave(popup);
  await expect(popup.getByTestId('notice')).toContainText('Storage rejected the change, so it was not saved');
  await expect(popup.getByTestId('notice')).toContainText('Your preview is kept');
  await expect(popup.getByTestId('excerpt')).toBeVisible();
  await expect(popup.getByLabel('Item', { exact: true })).toHaveValue(/.+/);
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(0);
  await popup.evaluate(() => chrome.storage.local.remove('filler'));
  await popup.getByRole('button', { name: 'Save merchant report' }).click();
  await expect(popup.getByTestId('notice')).toHaveText('Merchant report saved. No receipt was recorded.');
  let reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(1);

  // Re-sending the identical approved operation is a duplicate, never a second observation.
  const first = reports[0]!;
  const caseId = ((await storedRaw(granted)) as { cases: { id: string }[] }).cases[0]!.id;
  const approved = { id: first.id, kind: 'merchant_report', itemId: first.itemId, amountCents: 7000, occurredOn: null, source: 'Amazon page selection (captured)', note: '', reference: null, capture: first.capture };
  const send = (entry: unknown) => popup.evaluate(([e, c]) => chrome.runtime.sendMessage({ kind: 'mutate', command: { type: 'recordEntry', caseId: c, entry: e } }), [entry, caseId] as const);
  expect(await send(approved)).toMatchObject({ ok: true, outcome: 'duplicate' });
  // Conflicting reuse of the same capture id does not overwrite the evidence.
  expect(await send({ ...approved, capture: { ...first.capture, capturedAt: '2030-01-01T00:00:00.000Z' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toEqual([first]);
  await popup.close();

  // 2. Lost reply: the message reaches the real service worker and is saved, then the reply is lost.
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { items: [{ label: 'Lost-reply item', amount: '70' }] });
  popup = await openPopup(granted, windowId);
  await popup.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (message: unknown) => {
      await original(message);
      throw new Error('Simulated lost reply');
    };
  });
  await capture(popup);
  await assign(popup, /Lost-reply item/, 'Lost-reply item');
  await approveAndSave(popup);
  await expect(popup.getByTestId('notice')).toContainText('Saved. The extension’s reply was lost');
  await expect(popup.getByTestId('capture-saved')).toBeVisible();
  // The committed observation is not offered for re-entry.
  await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
  reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(2);
  expect(reports[1]?.capture).toMatchObject({ approvedAmountText: '$70.00' });
});

test('$35 issued vs $70 confirmed received needs review with net $70 and difference $0; voiding keeps provenance (acceptance 6)', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Synthetic item B', amount: '70' }] });
  await recordForItem(dash, 'Synthetic item B', 'Confirm money received', '70');
  await expect(dash.getByTestId('case-status')).toHaveText('Settled');

  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-35');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await assign(popup, /Synthetic item B/, 'Synthetic item B');
  await approveAndSave(popup);
  await expect(popup.getByTestId('capture-saved')).toBeVisible();

  const card = itemCard(dash, 'Synthetic item B');
  await expect(dash.getByTestId('case-status')).toHaveText('Needs review');
  await expect(card.getByTestId('item-net')).toHaveText('$70.00');
  await expect(card.getByTestId('item-difference')).toHaveText('$0.00');
  await expect(card.getByTestId('item-review-reasons')).toContainText('lower than the amount you confirmed receiving');

  const row = dash.getByTestId('timeline-entry').filter({ hasText: 'Merchant reported $35.00 issued (status snapshot, captured from selected page text)' });
  await row.getByRole('button', { name: /^Void/ }).click();
  await dash.getByLabel('Why is this entry mistaken?').fill('Selected the wrong item’s line');
  await dash.getByRole('button', { name: 'Void entry' }).click();
  await expect(dash.getByTestId('case-status')).toHaveText('Settled');
  await expect(row).toContainText('Voided');
  await expect(row.getByTestId('provenance')).toContainText('approved amount “$35.00”');
  await row.getByText('Approved excerpt').click();
  await expect(row.locator('pre.excerpt')).toHaveText('Synthetic item B\n\nRefund issued on October 3, 2026: $35.00');
  const stored = (await storedEntries(granted)).find((e) => e.kind === 'merchant_report');
  expect(stored?.capture).toMatchObject({ excerpt: 'Synthetic item B\n\nRefund issued on October 3, 2026: $35.00' });
  expect((await storedEntries(granted)).filter((e) => e.kind === 'receipt')).toHaveLength(1);
});

test('page-derived text is rendered literally in the preview and the timeline', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'hostile');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await expect(popup.getByTestId('excerpt')).toHaveText('Refund issued: $70.00\n\n<img src=x onerror="window.__pwned=1"><b>bold</b>');
  await expect(popup.locator('#app img, #app b')).toHaveCount(0);
  await assign(popup, /Synthetic headphones/, 'Synthetic headphones');
  await approveAndSave(popup);
  await expect(popup.getByTestId('capture-saved')).toBeVisible();
  await dash.getByText('Approved excerpt').click();
  await expect(dash.locator('pre.excerpt')).toContainText('<img src=x onerror=');
  await expect(dash.locator('#app img, #app b')).toHaveCount(0);
  for (const p of [popup, dash, page]) expect(await p.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('with no real case, the popup routes to case creation; nothing is saved', async ({ granted }) => {
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await expect(popup.getByTestId('no-cases')).toContainText('You have no cases yet');
  const dashPromise = granted.context!.waitForEvent('page', (p) => p.url().endsWith('/dashboard.html#create'));
  await popup.getByRole('button', { name: 'Create a case in the dashboard' }).click();
  const dash = await dashPromise;
  await expect(dash.getByRole('heading', { name: 'Create case' })).toBeVisible();
  expect(await storedRaw(granted)).toBeUndefined();
});

test('the capture collector cannot reach ledger storage from the page', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Secret label', amount: '1' }] });
  const { tabId, windowId } = await openSource(granted);
  const popup = await openPopup(granted, windowId);
  const probe = await popup.evaluate(async (id) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: id, frameIds: [0] },
      world: 'ISOLATED',
      func: async () => {
        try {
          const all = await chrome.storage.local.get(null);
          return `readable: ${JSON.stringify(all).length}`;
        } catch (err) {
          return `blocked: ${(err as Error).message}`;
        }
      },
    });
    return r?.result as string;
  }, tabId);
  expect(probe).toMatch(/^blocked/);
});

test('existing schema-1 data stays readable and captured evidence is appended without changing it (acceptance 7)', async ({ granted }) => {
  const legacy = {
    schemaVersion: 1,
    revision: 2,
    cases: [
      {
        id: 'legacy-case', retailer: 'amazon_us', orderRef: ORDER_A, currency: 'USD', isDemo: false,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
        items: [{ id: 'legacy-item', label: 'Legacy item', createdAt: '2026-01-01T00:00:00.000Z' }],
        entries: [
          { id: 'legacy-exp', kind: 'expectation', itemId: 'legacy-item', amountCents: 7000, recordedAt: '2026-01-01T00:00:00.000Z', occurredOn: null, source: 'Manual entry', note: 'Initial expected refund' },
          { id: 'legacy-report', kind: 'merchant_report', itemId: 'legacy-item', amountCents: 3500, recordedAt: '2026-01-01T00:00:01.000Z', occurredOn: '2026-01-01', source: 'Merchant order page (entered manually)', note: '', reference: null },
        ],
      },
    ],
  };
  const dash = await granted.openDashboard();
  await dash.evaluate((value) => chrome.storage.local.set({ 'refundReconciler.store': value }), legacy);
  await dash.reload();
  await dash.getByTestId('case-row').click();
  await expect(itemCard(dash, 'Legacy item').getByTestId('item-reported')).toHaveText('$35.00');

  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await assign(popup, `Order ${ORDER_A}`, 'Legacy item');
  await approveAndSave(popup);
  await expect(popup.getByTestId('capture-saved')).toBeVisible();
  await expect(itemCard(dash, 'Legacy item').getByTestId('item-reported')).toHaveText('$70.00');
  const stored = (await storedRaw(granted)) as typeof legacy;
  expect(stored.cases[0]!.entries.slice(0, 2)).toEqual(legacy.cases[0]!.entries);
  expect(stored.cases[0]!.entries).toHaveLength(3);
});
