import { STORE_KEY, createCase, expect, itemCard, recordForItem, test } from './fixtures';

test('loads as an MV3 extension with only the storage permission and a truthful empty state', async ({ session }) => {
  const page = await session.openDashboard();
  const manifest = await page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toEqual(['storage']);
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();

  await expect(page.getByTestId('empty-state')).toContainText('No cases yet.');
  await expect(page.getByTestId('empty-state')).toContainText('Nothing is captured');
  await expect(page.getByTestId('demo-cases')).toHaveCount(0);
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  expect(stored).toEqual({});

  // The toolbar action is wired to open the dashboard (the toolbar itself cannot be clicked from Playwright).
  const [worker] = session.context!.serviceWorkers();
  expect(await worker!.evaluate(() => chrome.action.onClicked.hasListeners())).toBe(true);
});

test('partial refund: one of two $35 items confirmed leaves $35 unresolved (acceptance 1)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: '111-2223334-5556667', items: [{ label: 'Blue kettle', amount: '35' }, { label: 'Red mug', amount: '$35.00' }] });
  await expect(page.getByTestId('notice')).toHaveText('Case saved.');
  await expect(page.getByRole('heading', { name: /Order 111-2223334-5556667/ })).toBeVisible();

  await recordForItem(page, 'Blue kettle', 'Confirm money received', '35.00');
  await expect(itemCard(page, 'Blue kettle').getByTestId('item-status')).toHaveText('Settled · confirmed received');
  await expect(itemCard(page, 'Red mug').getByTestId('item-status')).toHaveText('Funds unconfirmed');
  await expect(page.getByTestId('case-status')).toHaveText('Open');
  await expect(page.getByTestId('case-unresolved')).toHaveText('$35.00');
  await expect(page.getByTestId('case-net')).toHaveText('$35.00');
});

test('merchant-reported refund without confirmation stays unconfirmed (acceptance 2)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Headphones', amount: '70' }] });
  await recordForItem(page, 'Headphones', 'Record merchant report', '70');
  const card = itemCard(page, 'Headphones');
  await expect(card.getByTestId('item-status')).toHaveText('Merchant reports issued · receipt unconfirmed');
  await expect(card.getByTestId('item-reported')).toHaveText('$70.00');
  await expect(card.getByTestId('item-net')).toHaveText('$0.00');
  await expect(page.getByTestId('case-status')).not.toHaveText('Settled');
});

test('recharge reopens a settled case, and voiding it restores the state with an audit trail (acceptance 3, 9)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Jacket', amount: '70' }] });
  await recordForItem(page, 'Jacket', 'Confirm money received', '70', { reference: 'STMT-1' });
  await expect(page.getByTestId('case-status')).toHaveText('Settled');

  await recordForItem(page, 'Jacket', 'Record recharge', '20', { note: 'Charged again on statement' });
  const card = itemCard(page, 'Jacket');
  await expect(page.getByTestId('case-status')).toHaveText('Needs review');
  await expect(card.getByTestId('item-status')).toHaveText('Reopened · recharge recorded');
  await expect(card.getByTestId('item-net')).toHaveText('$50.00');
  await expect(card.getByTestId('item-difference')).toHaveText('$20.00');
  await expect(page.getByTestId('case-unresolved')).toHaveText('$20.00');

  // Void the recharge: calculations update, original evidence remains.
  const rechargeRow = page.getByTestId('timeline-entry').filter({ hasText: 'You recorded a $20.00 recharge' });
  await rechargeRow.getByRole('button', { name: /^Void/ }).click();
  await page.getByLabel('Why is this entry mistaken?').fill('Recharge was for a different order');
  await page.getByRole('button', { name: 'Void entry' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Settled');
  await expect(rechargeRow).toContainText('Voided');
  await expect(rechargeRow).toContainText('Charged again on statement');
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'Reason: Recharge was for a different order' })).toBeVisible();
  await expect(page.getByTestId('timeline-entry')).toHaveCount(4);
});

test('expected-amount edits and unknown expectations are visible and never treated as zero (acceptance 6)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Lamp', unknown: true }] });
  const card = itemCard(page, 'Lamp');
  await expect(card.getByTestId('item-expected')).toHaveText('Unknown');
  await expect(card.getByTestId('item-difference')).toHaveText('Unknown');
  await expect(card.getByTestId('item-status')).toHaveText('Expected amount unknown');
  await expect(page.getByTestId('case-status')).toHaveText('Open');

  await card.getByRole('button', { name: 'Edit expected amount' }).click();
  await page.getByTestId('entry-form').getByLabel('Unknown').uncheck();
  await page.getByTestId('entry-form').getByLabel('Expected refund (USD)').fill('24.99');
  await page.getByTestId('entry-form').getByRole('button', { name: 'Save' }).click();
  await expect(card.getByTestId('item-expected')).toHaveText('$24.99');
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'Expected refund changed from Unknown to $24.99' })).toBeVisible();
});

test('rejects malformed money input and saves nothing (acceptance 8)', async ({ session }) => {
  const page = await session.openDashboard();
  await page.getByRole('button', { name: 'Create case' }).click();
  await page.getByLabel('Item 1 description').fill('Shoes');
  const amount = page.getByLabel('Item 1 expected refund (USD)');
  for (const bad of ['12.345', '-5', 'abc', '1e3']) {
    await amount.fill(bad);
    await page.getByRole('button', { name: 'Save case' }).click();
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('notice')).toContainText('Nothing was saved');
  }
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  await amount.fill('0.10');
  await page.getByRole('button', { name: 'Save case' }).click();
  await recordForItem(page, 'Shoes', 'Confirm money received', '0.10');
  await expect(itemCard(page, 'Shoes').getByTestId('item-status')).toHaveText('Settled · confirmed received');
});

test('renders hostile text literally', async ({ session }) => {
  const page = await session.openDashboard();
  const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>bold</b>';
  await createCase(page, { orderRef: '<i>ref</i>', items: [{ label: hostile, amount: '5' }] });
  await recordForItem(page, hostile, 'Confirm money received', '5', { note: '<a href="javascript:alert(1)">click</a>', reference: '"><svg onload=alert(1)>' });

  await expect(page.getByRole('heading', { name: hostile, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order <i>ref</i>' })).toBeVisible();
  await expect(page.getByText('Note: <a href="javascript:alert(1)">click</a>')).toBeVisible();
  await expect(page.locator('#app img, #app script, #app b, #app i, #app a, #app svg')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  await page.getByRole('button', { name: '← All cases' }).click();
  await expect(page.getByTestId('case-row')).toContainText(hostile);
  await expect(page.locator('#app img, #app script')).toHaveCount(0);
});

test('saved data survives reload and a full browser restart (acceptance 10)', async ({ session }) => {
  let page = await session.openDashboard();
  await createCase(page, { orderRef: 'PERSIST-1', items: [{ label: 'Toaster', amount: '49.99' }] });
  await recordForItem(page, 'Toaster', 'Confirm money received', '20');

  await page.reload();
  await expect(page.getByTestId('case-row')).toContainText('Order PERSIST-1');

  await session.close();
  await session.launch();
  page = await session.openDashboard();
  await page.getByTestId('case-row').filter({ hasText: 'PERSIST-1' }).click();
  await expect(itemCard(page, 'Toaster').getByTestId('item-status')).toHaveText('Partially confirmed');
  await expect(page.getByTestId('case-unresolved')).toHaveText('$29.99');
});

test('a failed save is reported, keeps the form, and changes nothing (acceptance 10)', async ({ session }) => {
  const page = await session.openDashboard();
  // Fill chrome.storage.local to just under its 10 MB quota so the next write really fails.
  await page.evaluate(async () => {
    const quota = chrome.storage.local.QUOTA_BYTES;
    await chrome.storage.local.set({ filler: 'x'.repeat(quota - 'filler'.length - 2 - 64) });
  });
  await createCase(page, { items: [{ label: 'Blender', amount: '80' }] });
  await expect(page.getByTestId('notice')).toContainText('Storage rejected the change, so it was not saved');
  await expect(page.getByTestId('notice')).toContainText('Your input is kept');
  await expect(page.getByLabel('Item 1 description')).toHaveValue('Blender');
  const stored = await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY);
  expect(stored).toEqual({});

  await page.evaluate(() => chrome.storage.local.remove('filler'));
  await page.getByRole('button', { name: 'Save case' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Case saved.');
  await expect(itemCard(page, 'Blender')).toBeVisible();
});

test('unsupported stored data is shown, not reset, and only erased on explicit confirmation (acceptance 10)', async ({ session }) => {
  let page = await session.openDashboard();
  const future = { schemaVersion: 99, revision: 5, cases: [{ note: 'from a newer build' }] };
  await page.evaluate(([key, value]) => chrome.storage.local.set({ [key as string]: value }), [STORE_KEY, future] as const);
  await page.close();
  page = await session.openDashboard();

  await expect(page.getByTestId('unreadable')).toContainText('unsupported version');
  await expect(page.getByLabel(/Raw stored data/)).toHaveValue(/from a newer build/);
  await expect(page.getByRole('button', { name: 'Create case' })).toHaveCount(0);
  // A write attempted directly against the service worker is refused too.
  const res = await page.evaluate(() =>
    chrome.runtime.sendMessage({ kind: 'mutate', command: { type: 'loadDemo' } }),
  );
  expect(res).toMatchObject({ ok: false, error: { code: 'storage_unsupported' } });
  expect((await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY))[STORE_KEY]).toEqual(future);

  await page.getByRole('button', { name: 'Erase stored data…' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect((await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY))[STORE_KEY]).toEqual(future);
  await page.getByRole('button', { name: 'Erase stored data…' }).click();
  await page.getByRole('button', { name: 'Permanently erase' }).click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('corrupt stored data is reported without being overwritten', async ({ session }) => {
  let page = await session.openDashboard();
  const corrupt = { schemaVersion: 1, revision: 1, cases: [{ id: 'c', amountCents: 1.5 }] };
  await page.evaluate(([key, value]) => chrome.storage.local.set({ [key as string]: value }), [STORE_KEY, corrupt] as const);
  await page.close();
  page = await session.openDashboard();
  await expect(page.getByTestId('unreadable')).toContainText('could not be read');
  expect((await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY))[STORE_KEY]).toEqual(corrupt);
});

test('two open dashboards do not lose each other’s updates', async ({ session }) => {
  const a = await session.openDashboard();
  await createCase(a, { orderRef: 'MULTI', items: [{ label: 'Chair', amount: '100' }] });
  const b = await session.openDashboard();
  await b.getByTestId('case-row').filter({ hasText: 'MULTI' }).click();

  await recordForItem(a, 'Chair', 'Confirm money received', '30');
  // View B refreshes from storage change events.
  await expect(itemCard(b, 'Chair').getByTestId('item-net')).toHaveText('$30.00');
  await recordForItem(b, 'Chair', 'Confirm money received', '30');
  await expect(itemCard(a, 'Chair').getByTestId('item-net')).toHaveText('$60.00');
  await expect(b.getByTestId('timeline-entry').filter({ hasText: 'You confirmed $30.00 received' })).toHaveCount(2);

  // Simultaneous writes from both pages are serialised by the service worker; none is lost.
  const caseId = await a.evaluate(async (key) => {
    const s = (await chrome.storage.local.get(key))[key] as { cases: { id: string }[] };
    return s.cases[0]!.id;
  }, STORE_KEY);
  const itemId = await a.getByTestId('item').getAttribute('data-item-id');
  const send = (page: typeof a, id: string) =>
    page.evaluate(
      ([c, i, e]) =>
        chrome.runtime.sendMessage({
          kind: 'mutate',
          command: { type: 'recordEntry', caseId: c, entry: { id: e, kind: 'receipt', itemId: i, amountCents: 1000, occurredOn: null, source: 'Concurrent test', note: '', reference: null } },
        }),
      [caseId, itemId!, id] as const,
    );
  const results = await Promise.all([send(a, 'conc-a1'), send(b, 'conc-b1'), send(a, 'conc-a2'), send(b, 'conc-b2')]);
  expect(results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  await expect(itemCard(a, 'Chair').getByTestId('item-net')).toHaveText('$100.00');
  await expect(itemCard(b, 'Chair').getByTestId('item-status')).toHaveText('Settled · confirmed received');
});

test('deleting a case requires confirmation and removes its stored data', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'KEEP', items: [{ label: 'Keep me', amount: '1' }] });
  await page.getByRole('button', { name: '← All cases' }).click();
  await createCase(page, { orderRef: 'DELETE-ME', items: [{ label: 'Secret label', amount: '2' }] });

  await page.getByRole('button', { name: 'Delete case…' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: /DELETE-ME/ })).toBeVisible();

  await page.getByRole('button', { name: 'Delete case…' }).click();
  await page.getByRole('button', { name: 'Permanently delete' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Case deleted.');
  await expect(page.getByTestId('case-row')).toHaveCount(1);
  const raw = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
  expect(raw).not.toContain('Secret label');
  expect(raw).toContain('Keep me');
});

test('synthetic demo is opt-in and visibly separate from real cases', async ({ session }) => {
  const page = await session.openDashboard();
  await page.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(page.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
  await expect(page.getByTestId('demo-cases')).toContainText('Synthetic');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByRole('button', { name: 'Remove synthetic demo' }).click();
  await expect(page.getByTestId('demo-cases')).toHaveCount(0);
});

test('the dashboard is keyboard operable', async ({ session }) => {
  const page = await session.openDashboard();
  await page.getByRole('button', { name: 'Create case' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Order reference (optional)')).toBeFocused();
  await page.keyboard.type('KB-1');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Keyboard item');
  await page.keyboard.press('Tab');
  await page.keyboard.type('12.50');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notice')).toHaveText('Case saved.');
  await expect(page.getByRole('heading', { name: 'Order KB-1' })).toBeFocused();
});

test('balanced but conflicting evidence needs review in list and detail; voiding the observation restores settled (review finding 1)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'CONFLICT-1', items: [{ label: 'Coat', amount: '70' }, { label: 'Hat', amount: '35' }] });
  await recordForItem(page, 'Coat', 'Confirm money received', '70');
  await recordForItem(page, 'Hat', 'Confirm money received', '35');
  await expect(page.getByTestId('case-status')).toHaveText('Settled');

  await recordForItem(page, 'Coat', 'Record merchant report', '35');
  const coat = itemCard(page, 'Coat');
  // The balance is unchanged; only the evidence conflicts.
  await expect(page.getByTestId('case-status')).toHaveText('Needs review');
  await expect(page.getByTestId('case-net')).toHaveText('$105.00');
  await expect(page.getByTestId('case-unresolved')).toHaveText('$0.00');
  await expect(coat.getByTestId('item-status')).toHaveText('Settled · confirmed received');
  await expect(coat.getByTestId('item-difference')).toHaveText('$0.00');
  await expect(coat.getByTestId('item-needs-review')).toBeVisible();
  await expect(coat.getByTestId('item-review-reasons')).toContainText('lower than the amount you confirmed receiving');
  await expect(itemCard(page, 'Hat').getByTestId('item-needs-review')).toHaveCount(0);
  await expect(page.getByTestId('case-review')).toContainText('Coat: The merchant’s latest issued total is lower');

  await page.getByRole('button', { name: '← All cases' }).click();
  const row = page.getByTestId('case-row').filter({ hasText: 'CONFLICT-1' });
  await expect(row).toContainText('Needs review');
  await expect(row.getByTestId('case-row-review')).toHaveText('1 item to review: merchant report conflicts with confirmed receipts');

  await row.click();
  const reportRow = page.getByTestId('timeline-entry').filter({ hasText: 'Merchant reported $35.00 issued' });
  await reportRow.getByRole('button', { name: /^Void/ }).click();
  await page.getByLabel('Why is this entry mistaken?').fill('Snapshot read from the wrong order');
  await page.getByRole('button', { name: 'Void entry' }).click();
  await expect(page.getByTestId('case-status')).toHaveText('Settled');
  await expect(page.getByTestId('case-review')).toHaveCount(0);
  await expect(reportRow).toContainText('Voided');
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'Reason: Snapshot read from the wrong order' })).toBeVisible();
  await page.getByRole('button', { name: '← All cases' }).click();
  await expect(page.getByTestId('case-row').filter({ hasText: 'CONFLICT-1' })).toContainText('Settled');
});

test('a committed receipt whose reply is lost is shown as saved, not as a draft to re-enter (review finding 2)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Speaker', amount: '70' }] });
  // Fault injection inside the real extension page: the message really reaches
  // the service worker (which writes chrome.storage.local), then the reply is lost.
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime) as (m: unknown) => Promise<unknown>;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (message: unknown) => {
      await original(message);
      throw new Error('Simulated lost reply');
    };
  });
  await itemCard(page, 'Speaker').getByRole('button', { name: 'Confirm money received' }).click();
  await page.getByTestId('entry-form').getByRole('textbox', { name: /USD/ }).fill('70');
  await page.getByTestId('entry-form').getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('notice')).toContainText('Saved. The extension’s reply was lost');
  await expect(page.getByTestId('entry-form')).toHaveCount(0);
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'You confirmed $70.00 received' })).toHaveCount(1);
  await expect(itemCard(page, 'Speaker').getByTestId('item-status')).toHaveText('Settled · confirmed received');

  await page.reload();
  await page.getByTestId('case-row').click();
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'You confirmed $70.00 received' })).toHaveCount(1);
  await expect(itemCard(page, 'Speaker').getByTestId('item-net')).toHaveText('$70.00');
});

test('an unconfirmed receipt keeps its input and a retry reuses the same ID, recording it once (review finding 2)', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { items: [{ label: 'Monitor', amount: '70' }] });
  // The message never reaches the service worker, and the reply is missing.
  await page.evaluate(() => {
    const w = window as unknown as { __realSend: unknown };
    w.__realSend = chrome.runtime.sendMessage;
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = () => Promise.reject(new Error('Simulated channel failure'));
  });
  await itemCard(page, 'Monitor').getByRole('button', { name: 'Confirm money received' }).click();
  const form = page.getByTestId('entry-form');
  await form.getByRole('textbox', { name: /USD/ }).fill('70');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('notice')).toContainText('Could not confirm this change: it is not in your saved data right now');
  await expect(page.getByTestId('notice')).toContainText('reuses the same entry ID');
  await expect(page.getByTestId('notice')).not.toContainText('Not saved');
  await expect(form.getByRole('textbox', { name: /USD/ })).toHaveValue('70');
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'You confirmed' })).toHaveCount(0);

  // Restore messaging and resubmit the kept draft; then resubmit the same ID directly to prove idempotency.
  await page.evaluate(() => {
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = (window as unknown as { __realSend: unknown }).__realSend;
  });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('notice')).toHaveText('Entry saved.');
  const stored = await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY);
  const entries = (stored[STORE_KEY] as { cases: { id: string; entries: { id: string; kind: string; itemId: string; amountCents: number; occurredOn: null; source: string; note: string; reference: null }[] }[] }).cases[0]!;
  const receipt = entries.entries.find((e) => e.kind === 'receipt')!;
  const again = await page.evaluate(
    ([caseId, entry]) => chrome.runtime.sendMessage({ kind: 'mutate', command: { type: 'recordEntry', caseId, entry } }),
    [entries.id, { id: receipt.id, kind: receipt.kind, itemId: receipt.itemId, amountCents: receipt.amountCents, occurredOn: receipt.occurredOn, source: receipt.source, note: receipt.note, reference: receipt.reference }] as const,
  );
  expect(again).toMatchObject({ ok: true, outcome: 'duplicate' });
  await expect(page.getByTestId('timeline-entry').filter({ hasText: 'You confirmed $70.00 received' })).toHaveCount(1);
  await expect(itemCard(page, 'Monitor').getByTestId('item-net')).toHaveText('$70.00');
});
