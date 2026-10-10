// Regressions for the Task 02 review findings, through the real popup, the
// real service worker and chrome.storage.local. Pages are SYNTHETIC fixtures;
// page access comes from the temporary test copy (see capture-fixtures.ts),
// not from a toolbar gesture.

import type { Page } from '@playwright/test';
import { createCase } from './fixtures';
import {
  ORDER_A,
  ORDER_B,
  ORDER_PAGE,
  approveAndSave,
  assign,
  capture,
  expect,
  openPopup,
  openSource,
  pageFor,
  selectBlock,
  storedEntries,
  storedRaw,
  test,
} from './capture-fixtures';

const FALSE_OUTCOME = /Nothing was saved|not saved|has not been submitted|nothing changed|unchanged|Capture discarded/i;

async function caseIdFor(session: Parameters<typeof storedRaw>[0], orderRef: string | null): Promise<{ caseId: string; items: { id: string; label: string }[] }> {
  const raw = (await storedRaw(session)) as { cases: { id: string; orderRef: string | null; items: { id: string; label: string }[] }[] };
  const c = raw.cases.find((x) => x.orderRef === orderRef)!;
  return { caseId: c.id, items: c.items };
}

/** Makes the popup's own chrome.storage.local.get fail (the service worker is unaffected). */
async function setPopupReadsBroken(popup: Page, broken: boolean): Promise<void> {
  await popup.evaluate((b) => {
    const area = chrome.storage.local as unknown as { get: unknown };
    const w = window as unknown as { __realGet?: unknown };
    w.__realGet ??= area.get;
    area.get = b ? () => Promise.reject(new Error('Simulated popup read failure')) : w.__realGet;
  }, broken);
}

test('finding 1: malformed amount tokens are never proposed and add no observation', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const before = await storedRaw(granted);
  const { page, windowId } = await openSource(granted);
  const popup = await openPopup(granted, windowId);

  for (const [block, text] of [
    ['malformed-exp', 'Refund issued: $1e3'],
    ['malformed-space', 'Refund issued: $70 000.00'],
    ['malformed-slash', 'Refund issued: $70/00'],
  ] as const) {
    await selectBlock(page, block);
    await capture(popup);
    await expect(popup.getByTestId('excerpt')).toHaveText(text);
    await expect(popup.getByTestId('detected-amount')).toHaveText('Not found');
    await expect(popup.getByTestId('unsupported')).toContainText('could not be read safely');
    await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
    await popup.getByRole('button', { name: 'Discard' }).click();
  }

  // A forged command claiming the salvaged prefix is refused by the real service worker.
  const { caseId, items } = await caseIdFor(granted, ORDER_A);
  const res = await popup.evaluate(
    ([c, itemId]) =>
      chrome.runtime.sendMessage({
        kind: 'mutate',
        command: {
          type: 'recordEntry',
          caseId: c,
          entry: {
            id: 'cap-forged-1e3', kind: 'merchant_report', itemId, amountCents: 100, occurredOn: null,
            source: 'Amazon page selection (captured)', note: '', reference: null,
            capture: {
              sourceOrigin: 'https://www.amazon.com', sourcePath: '/gp/your-account/order-details', capturedAt: '2026-10-01T00:00:00.000Z',
              excerpt: 'Refund issued: $1e3', parserVersion: 'amazon-us-selection-2', approvedAmountText: '$1', detectedOrderRef: null, itemApplicabilityConfirmed: true,
            },
          },
        },
      }),
    [caseId, items[0]!.id] as const,
  );
  expect(res).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(await storedRaw(granted)).toEqual(before);
});

test('finding 2: the page address order is used for compatibility in the popup and the service worker', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Item in order A', amount: '70' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { orderRef: ORDER_B, items: [{ label: 'Item in order B', amount: '70' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { items: [{ label: 'Item with no order', amount: '70' }] });
  const before = await storedRaw(granted);

  // URL names order A; the selection has no order number.
  const { page, windowId } = await openSource(granted, ORDER_PAGE);
  await selectBlock(page, 'issued-35');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await expect(popup.getByTestId('detected-order')).toHaveText('Not in selection');
  await expect(popup.getByTestId('source-order')).toHaveText(ORDER_A);
  await assign(popup, `Order ${ORDER_B}`, 'Item in order B');
  await expect(popup.getByTestId('order-mismatch')).toContainText('different order than the one named by the page address');
  await popup.getByRole('checkbox', { name: /is the refund for this one item/ }).check();
  await expect(popup.getByRole('button', { name: 'Save merchant report' })).toBeDisabled();

  // The same provenance sent straight to the service worker is refused too.
  const b = await caseIdFor(granted, ORDER_B);
  const direct = await popup.evaluate(
    ([c, itemId]) =>
      chrome.runtime.sendMessage({
        kind: 'mutate',
        command: {
          type: 'recordEntry',
          caseId: c,
          entry: {
            id: 'cap-direct-url-mismatch', kind: 'merchant_report', itemId, amountCents: 3500, occurredOn: '2026-10-03',
            source: 'Amazon page selection (captured)', note: '', reference: null,
            capture: {
              sourceOrigin: 'https://www.amazon.com', sourcePath: '/gp/your-account/order-details?orderID=112-1234567-7654321', capturedAt: '2026-10-01T00:00:00.000Z',
              excerpt: 'Synthetic item B\n\nRefund issued on October 3, 2026: $35.00', parserVersion: 'amazon-us-selection-2', approvedAmountText: '$35.00', detectedOrderRef: null, itemApplicabilityConfirmed: true,
            },
          },
        },
      }),
    [b.caseId, b.items[0]!.id] as const,
  );
  expect(direct).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('different order') } });
  expect(await storedRaw(granted)).toEqual(before);

  // A case without an order number cannot be checked: allowed, with a note.
  await assign(popup, /Item with no order/, 'Item with no order');
  await expect(popup.getByTestId('order-unchecked')).toBeVisible();
  // The matching case is allowed.
  await assign(popup, `Order ${ORDER_A}`, 'Item in order A');
  await expect(popup.getByTestId('order-mismatch')).toHaveCount(0);
  await approveAndSave(popup);
  await expect(popup.getByTestId('capture-saved')).toContainText('Item in order A');
  const reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(1);
  expect(reports[0]?.capture).toMatchObject({ sourcePath: `/gp/your-account/order-details?orderID=${ORDER_A}`, detectedOrderRef: null });
  const a = await caseIdFor(granted, ORDER_A);
  expect(reports[0]?.itemId).toBe(a.items[0]!.id);

  // URL (order A) and selected text (order B) disagree: no proposal at all.
  await popup.getByRole('button', { name: 'Capture another' }).click();
  await selectBlock(page, 'issued-35-order-b');
  await capture(popup);
  await expect(popup.getByTestId('unsupported')).toContainText('The page address and the selected text name different orders');
  await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Discard' }).click();
  await popup.close();

  // Conflicting order IDs in the query stay ambiguous; the first is not taken.
  const ambiguous = await openSource(granted, pageFor(ORDER_A, `orderId=${ORDER_B}`));
  await selectBlock(ambiguous.page, 'issued-35');
  const p2 = await openPopup(granted, ambiguous.windowId);
  await capture(p2);
  await expect(p2.getByTestId('source-order')).toContainText('Ambiguous');
  await expect(p2.getByTestId('unsupported')).toContainText('page address names more than one order');
  await expect(p2.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
  await p2.close();

  // Duplicate identical query values are one order; no order anywhere stays unknown and any case may be chosen.
  const dup = await openSource(granted, pageFor(ORDER_B, `orderID=${ORDER_B}`));
  await selectBlock(dup.page, 'issued-35');
  const p3 = await openPopup(granted, dup.windowId);
  await capture(p3);
  await expect(p3.getByTestId('source-order')).toHaveText(ORDER_B);
  await p3.close();
  const none = await openSource(granted, pageFor(null));
  await selectBlock(none.page, 'issued-35');
  const p4 = await openPopup(granted, none.windowId);
  await capture(p4);
  await expect(p4.getByTestId('source-order')).toHaveText('Not in address');
  await assign(p4, `Order ${ORDER_B}`, 'Item in order B');
  await expect(p4.getByTestId('order-mismatch')).toHaveCount(0);
  await approveAndSave(p4);
  await expect(p4.getByTestId('capture-saved')).toContainText('Item in order B');
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(2);
});

test('finding 3: a pending save is locked to its approved target; the result and storage agree', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Item A', amount: '35' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { items: [{ label: 'Item B', amount: '35' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-35');
  const popup = await openPopup(granted, windowId);

  // The real command reaches the worker and is written; only the reply is held back.
  await popup.evaluate(() => {
    const w = window as unknown as { __release: () => void; __realSend: unknown };
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    w.__realSend = chrome.runtime.sendMessage;
    const gate = new Promise<void>((resolve) => { w.__release = resolve; });
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (message: unknown) => {
      const reply = await original(message);
      await gate;
      return reply;
    };
  });
  await capture(popup);
  await assign(popup, /Item A/, 'Item A');
  await approveAndSave(popup);
  await expect(popup.getByTestId('submitted-target')).toContainText('“Item A”');
  await expect(popup.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  // While saving, the assignment controls are gone and cannot be retargeted.
  await expect(popup.locator('#capture-case, #capture-item, #capture-confirm')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Stop waiting' })).toBeDisabled();
  await expect.poll(async () => (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report').length).toBe(1);

  await popup.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(popup.getByTestId('capture-saved')).toContainText('“Item A”');
  await expect(popup.getByTestId('capture-saved')).not.toContainText('Item B');
  const reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(1);
  const raw = (await storedRaw(granted)) as { cases: { items: { id: string; label: string }[] }[] };
  const itemA = raw.cases.flatMap((c) => c.items).find((i) => i.label === 'Item A')!;
  expect(reports[0]!.itemId).toBe(itemA.id);
});

test('finding 3: an uncertain save stays locked, and a retry resends the identical operation', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { items: [{ label: 'Item A', amount: '35' }] });
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { items: [{ label: 'Item B', amount: '35' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-35');
  const popup = await openPopup(granted, windowId);

  // First attempt never reaches the worker and has no reply; record every payload sent.
  await popup.evaluate(() => {
    const w = window as unknown as { __realSend: (m: unknown) => Promise<unknown>; __sent: string[]; __fail: boolean };
    w.__realSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    w.__sent = [];
    w.__fail = true;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = (message: unknown) => {
      w.__sent.push(JSON.stringify(message));
      return w.__fail ? Promise.reject(new Error('Simulated channel failure')) : w.__realSend(message);
    };
  });
  await capture(popup);
  await assign(popup, /Item A/, 'Item A');
  await approveAndSave(popup);
  await expect(popup.getByTestId('notice')).toContainText('Could not confirm this save: the report for “Item A” is not in your saved data');
  await expect(popup.getByTestId('submitted-target')).toContainText('“Item A”');
  await expect(popup.locator('#capture-case, #capture-item, #capture-confirm')).toHaveCount(0);
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(0);

  await popup.evaluate(() => { (window as unknown as { __fail: boolean }).__fail = false; });
  await popup.getByRole('button', { name: 'Retry the same save' }).click();
  await expect(popup.getByTestId('capture-saved')).toContainText('“Item A”');
  const sent = await popup.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  const reports = (await storedEntries(granted)).filter((e) => e.kind === 'merchant_report');
  expect(reports).toHaveLength(1);
  expect(JSON.parse(sent[0]!).command.entry.id).toBe(reports[0]!.id);
  // Resending the identical operation once more is a duplicate.
  const again = await popup.evaluate((m) => (window as unknown as { __realSend: (m: unknown) => Promise<unknown> }).__realSend(JSON.parse(m)), sent[0]!);
  expect(again).toMatchObject({ ok: true, outcome: 'duplicate' });
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(1);
});

test('finding 4: committed write, lost reply and failed popup reads make no false claim, then recover as saved', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(granted, windowId);
  await capture(popup);
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic headphones');

  await popup.evaluate(() => {
    const w = window as unknown as { __realSend: unknown };
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    w.__realSend = chrome.runtime.sendMessage;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (message: unknown) => {
      await original(message); // the real worker commits the write
      throw new Error('Simulated lost reply');
    };
  });
  await setPopupReadsBroken(popup, true);
  await approveAndSave(popup);

  await expect(popup.getByTestId('notice')).toContainText('Could not confirm whether the report for “Synthetic headphones” was saved, and saved data could not be re-read');
  await expect(popup.getByTestId('cases-unreadable')).toContainText('This does not mean the save failed');
  await expect(popup.getByTestId('submitted-target')).toContainText('“Synthetic headphones”');
  await expect(popup.locator('body')).not.toContainText(FALSE_OUTCOME);
  await expect(popup.getByRole('button', { name: 'Save merchant report' })).toHaveCount(0);
  // Independent check through the worker: exactly one report.
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(1);

  await setPopupReadsBroken(popup, false);
  await popup.getByRole('button', { name: 'Read saved data again' }).click();
  await expect(popup.getByTestId('notice')).toContainText('Saved. The extension’s reply was lost, but the report is in your saved data');
  await expect(popup.getByTestId('capture-saved')).toContainText('“Synthetic headphones”');
  await expect(popup.getByTestId('assign')).toHaveCount(0);
  await expect(popup.getByTestId('submitted')).toHaveCount(0);
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(1);
});

test('finding 4: stopping an uncertain save makes no claim; an unsubmitted cancel and unreadable cases stay accurate', async ({ granted }) => {
  const dash = await granted.openDashboard();
  await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
  const { page, windowId } = await openSource(granted);
  await selectBlock(page, 'issued-70');
  const popup = await openPopup(granted, windowId);

  // Unsubmitted preview while cases can't be read: says only that.
  await setPopupReadsBroken(popup, true);
  // A change from another view makes the popup re-read saved data, which now fails.
  await dash.getByRole('button', { name: '← All cases' }).click();
  await createCase(dash, { items: [{ label: 'Another item', amount: '5' }] });
  await capture(popup);
  await expect(popup.getByTestId('cases-unreadable')).toContainText('Saved cases can’t be read right now');
  await expect(popup.getByTestId('cases-unreadable')).not.toContainText(/Nothing was saved/);
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup.getByTestId('notice')).toHaveText('Capture discarded. Nothing was saved.');
  await setPopupReadsBroken(popup, false);

  // Submitted, committed by the worker, reply lost and popup reads failing; then the user stops waiting.
  await capture(popup);
  await assign(popup, `Order ${ORDER_A}`, 'Synthetic headphones');
  await popup.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (message: unknown) => {
      await original(message);
      throw new Error('Simulated lost reply');
    };
  });
  await setPopupReadsBroken(popup, true);
  await approveAndSave(popup);
  await expect(popup.getByTestId('notice')).toContainText('Could not confirm whether the report');
  await popup.getByRole('button', { name: 'Stop waiting' }).click();
  await expect(popup.getByTestId('notice')).toContainText('It may already have been saved for “Synthetic headphones”');
  await expect(popup.locator('body')).not.toContainText(FALSE_OUTCOME);
  expect((await storedEntries(granted)).filter((e) => e.kind === 'merchant_report')).toHaveLength(1);
});
