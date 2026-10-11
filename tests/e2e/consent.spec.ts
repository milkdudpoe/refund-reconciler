// Task 10: the data-practices disclosure and explicit agreement, through the
// real production service worker, dashboard and popup. All data is
// SYNTHETIC. Disclosed test setup: to simulate an earlier installation, a
// damaged receipt or a future data-practices change, a test writes or removes
// the consent receipt (or seeds an earlier version's plaintext ledger)
// directly in chrome.storage.local from the service worker or an extension
// page; agreement itself always happens through the real UI. Replies are held
// only after the real worker answered them (vault-helpers.ts), so every
// ordering is deterministic and production code is unchanged. Capture tests
// use the synthetic fixture pages and the temporary test copy with fixture-only
// host access (see capture-fixtures.ts).

import type { Page } from '@playwright/test';
import { createCase, type ExtensionSession } from './fixtures';
import { ORDER_A, approveAndSave, assign, capture, expect, openPopup, openSource, selectBlock, storedEntries, test } from './capture-fixtures';
import { clipboardCalls, gateClipboard, openSummary } from './export-helpers';
import { envelopeOf, rejectNextWorkerWrite, sendRaw, serviceWorker } from './restore-helpers';
import {
  CONSENT_KEY,
  LEGACY_KEY,
  TEST_PHRASE,
  VAULT_KEY,
  acceptViaUi,
  consentGate,
  decryptedRaw,
  downloadStarts,
  holdNextReplyOfKind,
  instrumentDownloads,
  instrumentTabAccess,
  ledgerStatus,
  migrateViaUi,
  releaseReplyOfKind,
  resetTabAccess,
  setupViaUi,
  tabAccess,
  unlockViaUi,
  vaultScreen,
  waitForHeldReplyOfKind,
} from './vault-helpers';
import { richLegacyLedger } from '../shared/rich-ledger';

const CANARY = 'SYNTHETIC-CONSENT-CANARY-7f3a';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECTIONS = ['Purpose', 'What you type or import', 'Optional capture from Amazon US pages', 'Use and sharing', 'Storage and retention', 'Your choices'];

const local = (p: Page) => p.evaluate(() => chrome.storage.local.get(null));

/** Writes (or with null removes) the consent receipt from the service worker, as damage, an older version or another view would leave it. */
async function setReceipt(session: ExtensionSession, value: unknown): Promise<void> {
  await serviceWorker(session).evaluate(
    async ([k, v]) => {
      if (v === null) await chrome.storage.local.remove(k as string);
      else await chrome.storage.local.set({ [k as string]: v });
    },
    [CONSENT_KEY, value] as const,
  );
}

/** Opens popup.html in the source tab's window (as the toolbar would), without expecting Capture to be offered. */
async function openPopupIn(session: ExtensionSession, windowId: number): Promise<Page> {
  const pagePromise = session.context!.waitForEvent('page', (p) => p.url().endsWith('/popup.html'));
  await serviceWorker(session).evaluate((win) => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false, windowId: win }), windowId);
  const popup = await pagePromise;
  await expect(popup.getByTestId('popup-locked').or(popup.getByRole('button', { name: 'Capture selected refund text' }))).toBeVisible();
  return popup;
}

const popupGate = (p: Page) => p.getByTestId('popup-locked');
const captureButton = (p: Page) => p.getByRole('button', { name: 'Capture selected refund text' });

test.describe('a fresh installation', () => {
  test('dashboard: the data practices come first; Not now, reload and reading never agree; a failed agreement stays gated; agreement leads to setup', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    const gate = consentGate(page);
    await expect(gate).toHaveAttribute('data-reason', 'missing');
    await expect(gate.getByRole('heading', { level: 2, name: 'How Refund Reconciler handles your data' })).toBeVisible();
    for (const title of SECTIONS) await expect(gate.getByRole('heading', { level: 3, name: title })).toBeAttached();
    // Representative content: purpose, data types, capture limits, sharing, protection and export limits.
    await expect(gate).toContainText('Amazon US returns');
    await expect(gate).toContainText('up to 4,000 characters');
    await expect(gate).toContainText('does not read the rest of the page, form fields, passwords, cookies or other tabs');
    await expect(gate).toContainText('not sent to the publisher or any other service');
    await expect(gate).toContainText('There is no recovery service');
    await expect(gate).toContainText('JSON backups, case summaries and copied text are not encrypted');
    // No data form, passphrase field, checkbox or data action before agreement.
    await expect(page.locator('#app input:not(#erase-typed)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create case' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load synthetic demo' })).toHaveCount(0);
    expect(await local(page)).toEqual({});
    expect(await ledgerStatus(page)).toBe('consent_required');

    // Reading "Data and privacy" and the guide is not agreement.
    await page.getByText('Data and privacy', { exact: true }).click();
    await expect(page.getByTestId('privacy')).toContainText('Reading it here changes nothing');
    await expect(page.getByTestId('privacy').getByRole('button')).toHaveCount(0);
    await page.getByText('How to use Refund Reconciler').click();
    await expect(gate).toBeVisible();
    expect(await local(page)).toEqual({});

    // Not now: nothing changes and data features stay unavailable.
    await page.getByRole('button', { name: 'Not now' }).click();
    const deferred = page.getByTestId('consent-deferred');
    await expect(deferred.getByRole('heading', { name: 'Data features are unavailable' })).toBeFocused();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    expect(await local(page)).toEqual({});
    await page.getByRole('button', { name: 'Review data practices' }).click();
    await expect(gate.getByRole('heading', { level: 2 })).toBeFocused();

    // Reloading never agrees.
    await page.reload();
    await expect(gate).toBeVisible();
    expect(await local(page)).toEqual({});

    // A rejected write is reported and stays at the disclosure.
    await rejectNextWorkerWrite(session);
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    const feedback = page.getByTestId('consent-feedback');
    await expect(feedback).toHaveAttribute('role', 'alert');
    await expect(feedback).toContainText('not recorded');
    await expect(gate).toBeVisible();
    await expect(vaultScreen(page, 'vault-setup')).toHaveCount(0);
    expect(await local(page)).toEqual({});

    // Agreement leads to "Protect your records", not to an empty dashboard.
    await acceptViaUi(page);
    await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your cases' })).toHaveCount(0);
    const stored = await local(page);
    expect(Object.keys(stored)).toEqual([CONSENT_KEY]);
    expect(stored[CONSENT_KEY]).toEqual({ format: 'refund-reconciler-consent', formatVersion: 1, dataPracticesVersion: 1, acceptedAt: expect.stringMatching(ISO) });
    await setupViaUi(page);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    expect(Object.keys(await local(page)).sort()).toEqual([CONSENT_KEY, VAULT_KEY]);
  });

  test('popup: explains that agreement is needed and offers the dashboard, with no tab look-up, selection read or injection', async ({ granted: session }) => {
    await instrumentTabAccess(session.context!);
    const { page: source, windowId } = await openSource(session);
    await selectBlock(source, 'issued-70');
    const popup = await openPopupIn(session, windowId);
    await expect(popupGate(popup)).toHaveAttribute('data-state', 'consent_required');
    await expect(popupGate(popup)).toContainText('please read how it handles your data and agree in the dashboard');
    await expect(popupGate(popup)).toContainText('Nothing on this page has been read');
    await expect(captureButton(popup)).toHaveCount(0);
    await expect(popup.getByRole('button', { name: /Agree/ })).toHaveCount(0);
    expect(await tabAccess(popup)).toEqual([]);
    expect(await local(popup)).toEqual({});

    // The offered button opens the dashboard, which shows the disclosure.
    const opened = session.context!.waitForEvent('page', (p) => p.url().includes('/dashboard.html'));
    await popup.getByRole('button', { name: 'Open dashboard to review' }).click();
    const dash = await opened;
    await expect(consentGate(dash)).toBeVisible();
    expect(await local(dash)).toEqual({});
  });
});

test.describe('agreement once per profile', () => {
  test('survives reopening, a worker stop and a browser restart; the restart still locks; rereading keeps drafts and writes nothing', async ({ session }) => {
    const page = await session.openDashboard();
    await createCase(page, { orderRef: 'CONSENT-1', items: [{ label: `${CANARY} lamp`, amount: '20' }] });
    const receipt = (await local(page))[CONSENT_KEY];
    expect(receipt).toMatchObject({ dataPracticesVersion: 1 });
    await page.close();

    const again = await session.context!.newPage();
    await again.goto(session.dashboardUrl);
    await expect(again.getByRole('heading', { name: 'Your cases' })).toBeVisible();
    await expect(consentGate(again)).toHaveCount(0);

    const cdp = await session.context!.newCDPSession(again);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    expect(await ledgerStatus(again)).toBe('ok');

    // A draft and open panels survive rereading the disclosure; nothing is written.
    await again.getByTestId('case-row').click();
    await again.getByRole('button', { name: 'Record merchant report' }).click();
    await again.getByTestId('entry-form').getByLabel('Note (optional)').fill('synthetic draft note');
    await again.getByText('How to use Refund Reconciler').click();
    const before = JSON.stringify(await local(again));
    await again.getByText('Data and privacy', { exact: true }).click();
    await expect(again.getByTestId('privacy')).toHaveAttribute('open');
    await expect(again.getByTestId('privacy')).toContainText('Optional capture from Amazon US pages');
    await again.getByText('Data and privacy', { exact: true }).click();
    await expect(again.getByTestId('entry-form').getByLabel('Note (optional)')).toHaveValue('synthetic draft note');
    await expect(again.getByTestId('help')).toHaveAttribute('open');
    expect(JSON.stringify(await local(again))).toBe(before);

    await session.close();
    await session.launch();
    const after = await session.openDashboard({ accept: false });
    await expect(vaultScreen(after, 'vault-locked')).toBeVisible();
    await expect(consentGate(after)).toHaveCount(0);
    expect((await local(after))[CONSENT_KEY]).toEqual(receipt);
    await unlockViaUi(after);
    await expect(after.getByTestId('case-row')).toContainText('CONSENT-1');
  });
});

test.describe('existing installations', () => {
  test('encrypted records as 0.7.0 left them stay intact while agreement is pending; nothing implies agreement; agreement leads to unlock', async ({ session }) => {
    const page = await session.openDashboard();
    await createCase(page, { orderRef: 'CONSENT-OLD', items: [{ label: `${CANARY} radio`, amount: '25' }] });
    const s = (await decryptedRaw(page)) as { revision: number; ledgerEpoch: string };
    // A 0.7.0 installation after the update: an encrypted vault, no agreement, and (after the update) a locked vault.
    await setReceipt(session, null);
    await session.close();
    await session.launch();
    const gated = await session.openDashboard({ accept: false });
    await expect(consentGate(gated)).toHaveAttribute('data-reason', 'missing');
    const stored = await local(gated);
    expect(Object.keys(stored)).toEqual([VAULT_KEY]);

    // Direct requests are refused at the worker: no unlock, setup, migration, demo, restore or legacy read.
    for (const msg of [
      { kind: 'unlock', passphrase: TEST_PHRASE },
      { kind: 'setup', passphrase: TEST_PHRASE, acknowledged: true },
      { kind: 'migrate', passphrase: TEST_PHRASE, acknowledged: true, replaceCandidate: false },
      { kind: 'mutate', command: { type: 'loadDemo' } },
      { kind: 'restore', operationId: 'op-consent', expected: { revision: s.revision, stored: true, epoch: s.ledgerEpoch }, backup: envelopeOf({ schemaVersion: 1, revision: 0, cases: [] }) },
      { kind: 'readLegacy' },
    ]) {
      expect(await sendRaw(gated, msg), msg.kind).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    }
    expect(await local(gated)).toEqual(stored);

    // Not now and closing keep everything.
    await gated.getByRole('button', { name: 'Not now' }).click();
    await gated.close();
    const reopened = await session.openDashboard({ accept: false });
    await expect(consentGate(reopened)).toBeVisible();
    expect(await local(reopened)).toEqual(stored);

    // Agreement leads to the installation's existing state: locked.
    await acceptViaUi(reopened);
    await expect(vaultScreen(reopened, 'vault-locked')).toBeVisible();
    await unlockViaUi(reopened);
    await expect(reopened.getByTestId('case-row')).toContainText('CONSENT-OLD');
    expect((await local(reopened))[VAULT_KEY]).toEqual(stored[VAULT_KEY]);
  });

  test('plaintext records from an earlier version are kept as they are until agreement, then migrated as before', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    const legacy = richLegacyLedger();
    await page.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, legacy] as const);
    await page.reload();
    await expect(consentGate(page)).toBeVisible();
    // Nothing reveals the earlier records before agreement.
    await expect(page.locator('#app')).not.toContainText(`${legacy.cases.length} cases`);
    await expect(page.locator('#app')).not.toContainText('without encryption');
    expect(await sendRaw(page, { kind: 'readLegacy' })).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(await sendRaw(page, { kind: 'migrate', passphrase: TEST_PHRASE, acknowledged: true, replaceCandidate: false })).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(await local(page)).toEqual({ [LEGACY_KEY]: legacy });

    await acceptViaUi(page);
    await expect(vaultScreen(page, 'vault-migrate')).toContainText(`saved ${legacy.cases.length} cases`);
    const receipt = (await local(page))[CONSENT_KEY];
    await migrateViaUi(page);
    expect(await decryptedRaw(page)).toEqual(legacy);
    // Migration neither creates nor changes the agreement.
    expect(await local(page)).toMatchObject({ [CONSENT_KEY]: receipt });
    expect(Object.keys(await local(page)).sort()).toEqual([CONSENT_KEY, VAULT_KEY]);
  });
});

test.describe('agreement removed, damaged or obsolete while views are open', () => {
  test('every open dashboard and the popup return to the gate and drop private state, for each kind of change', async ({ granted: session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: ORDER_A, items: [{ label: `${CANARY} headphones`, amount: '70' }] });
    const receipt = (await local(a))[CONSENT_KEY] as Record<string, unknown>;
    const b = await session.openDashboard();
    const { page: source, windowId } = await openSource(session);

    for (const [value, reason] of [
      [null, 'missing'],
      [{ ...receipt, acceptedAt: 'damaged' }, 'invalid'],
      [{ ...receipt, dataPracticesVersion: 2 }, 'obsolete'],
    ] as const) {
      // B has a half-typed entry; the popup holds a capture preview with the selected text.
      await b.getByTestId('case-row').click();
      await b.getByRole('button', { name: 'Record merchant report' }).click();
      await b.getByTestId('entry-form').getByLabel('Note (optional)').fill(`${CANARY} draft`);
      await selectBlock(source, 'issued-70');
      const popup = await openPopup(session, windowId);
      await capture(popup);
      await expect(popup.getByTestId('excerpt')).toContainText('Refund issued: $70.00');

      await setReceipt(session, value);
      for (const view of [a, b]) {
        await expect(consentGate(view)).toHaveAttribute('data-reason', reason);
        await expect(view.locator('#app')).not.toContainText(CANARY);
      }
      await expect(popupGate(popup)).toHaveAttribute('data-state', 'consent_required');
      await expect(popup.getByTestId('excerpt')).toHaveCount(0);
      await expect(popup.locator('body')).not.toContainText('Refund issued');
      if (reason !== 'missing') await expect(a.getByTestId('consent-reason')).toBeVisible();

      // The records are untouched; agreeing again returns every view (the session is still unlocked).
      await acceptViaUi(a);
      await expect(a.getByTestId('case-row')).toContainText(ORDER_A);
      await expect(b.getByRole('heading', { name: 'Your cases' })).toBeVisible();
      await expect(b.getByTestId('entry-form')).toHaveCount(0);
      await popup.close();
    }
    expect((await storedEntries(session)).filter((e) => e.kind === 'merchant_report')).toEqual([]);
  });
});

test.describe('delayed replies from before the change', () => {
  test('a held unlocked read, export confirmation or copy confirmation cannot restore data or start an export after agreement is removed', async ({ session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'CONSENT-HOLD', items: [{ label: `${CANARY} kettle`, amount: '40' }] });
    const b = await session.openDashboard();

    // 1. A change-triggered unlocked read, answered by the real worker, delivered only after the removal.
    await a.getByRole('button', { name: '← All cases' }).click();
    await holdNextReplyOfKind(a, 'read');
    await b.getByRole('button', { name: 'Load synthetic demo' }).click();
    await waitForHeldReplyOfKind(a, 'read');
    await setReceipt(session, null);
    await expect(consentGate(a)).toBeVisible();
    await releaseReplyOfKind(a, 'read');
    await expect(consentGate(a)).toBeVisible();
    await expect(a.locator('#app')).not.toContainText(CANARY);
    await acceptViaUi(a);
    await expect(a.getByRole('heading', { name: 'Your cases' })).toBeVisible();

    // 2. Download: the action-time confirmation read is held across the removal; no download starts.
    await instrumentDownloads(a);
    await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
    await expect(a.getByRole('button', { name: 'Download JSON', exact: true })).toBeEnabled();
    await holdNextReplyOfKind(a, 'read');
    await a.getByRole('button', { name: 'Download JSON', exact: true }).click();
    await waitForHeldReplyOfKind(a, 'read');
    await setReceipt(session, null);
    await expect(consentGate(a)).toBeVisible();
    await releaseReplyOfKind(a, 'read');
    expect(await downloadStarts(a)).toBe(0);
    await expect(a.getByTestId('export-panel')).toHaveCount(0);
    await acceptViaUi(a);

    // 3. Copy: the same for a case summary; the clipboard is never written.
    await a.getByTestId('case-row').filter({ hasText: 'CONSENT-HOLD' }).click();
    await openSummary(a);
    await gateClipboard(a, { realWrite: false });
    await holdNextReplyOfKind(a, 'read');
    await a.getByRole('button', { name: 'Copy text' }).click();
    await waitForHeldReplyOfKind(a, 'read');
    await setReceipt(session, null);
    await expect(consentGate(a)).toBeVisible();
    await releaseReplyOfKind(a, 'read');
    expect((await clipboardCalls(a)).calls).toBe(0);
    await expect(a.locator('#app')).not.toContainText(CANARY);
  });

  test('a held capture check cannot read the selection after agreement is removed', async ({ granted: session }) => {
    await instrumentTabAccess(session.context!);
    const dash = await session.openDashboard();
    await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
    const { page: source, windowId } = await openSource(session);
    await selectBlock(source, 'issued-70');
    const popup = await openPopup(session, windowId);
    await resetTabAccess(popup);
    await holdNextReplyOfKind(popup, 'read');
    await capture(popup);
    await waitForHeldReplyOfKind(popup, 'read');
    await setReceipt(session, null);
    await expect(popupGate(popup)).toHaveAttribute('data-state', 'consent_required');
    await releaseReplyOfKind(popup, 'read');
    await expect(popupGate(popup)).toBeVisible();
    await expect(popup.getByTestId('preview')).toHaveCount(0);
    expect(await tabAccess(popup)).not.toContain('scripting.executeScript');
  });

  test('a held pre-migration plaintext backup is discarded when agreement is removed', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    await page.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, richLegacyLedger()] as const);
    await page.reload();
    await acceptViaUi(page);
    await expect(vaultScreen(page, 'vault-migrate')).toBeVisible();
    await instrumentDownloads(page);
    await holdNextReplyOfKind(page, 'readLegacy');
    await page.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click();
    await waitForHeldReplyOfKind(page, 'readLegacy');
    await setReceipt(session, null);
    await expect(consentGate(page)).toBeVisible();
    await releaseReplyOfKind(page, 'readLegacy');
    expect(await downloadStarts(page)).toBe(0);
    await expect(consentGate(page)).toBeVisible();
    expect(Object.keys(await local(page))).toEqual([LEGACY_KEY]);
  });

  test('an agreement whose reply is overtaken by an erase in another view does not lead to setup', async ({ session }) => {
    const a = await session.openDashboard();
    await createCase(a, { orderRef: 'CONSENT-ERASE', items: [{ label: `${CANARY} mug`, amount: '9' }] });
    await setReceipt(session, null);
    await expect(consentGate(a)).toBeVisible();
    const b = await session.openDashboard({ accept: false });
    await expect(consentGate(b)).toBeVisible();

    await holdNextReplyOfKind(a, 'acceptDataPractices');
    await a.getByRole('button', { name: 'Agree and continue' }).click();
    await waitForHeldReplyOfKind(a, 'acceptDataPractices');
    // The agreement committed; B follows it, then locks and erases with the typed confirmation.
    await expect(b.getByRole('heading', { name: 'Your cases' })).toBeVisible();
    await b.getByRole('button', { name: 'Lock now' }).click();
    await expect(vaultScreen(b, 'vault-locked')).toBeVisible();
    await b.getByText('Forgot your passphrase?').click();
    await b.getByRole('button', { name: 'Erase stored data…' }).click();
    await b.getByLabel('Type ERASE to confirm').fill('ERASE');
    await b.getByRole('button', { name: 'Permanently erase' }).click();
    await expect(consentGate(b)).toHaveAttribute('data-reason', 'missing');

    await releaseReplyOfKind(a, 'acceptDataPractices');
    await expect(consentGate(a)).toHaveAttribute('data-reason', 'missing');
    await expect(vaultScreen(a, 'vault-setup')).toHaveCount(0);
    await expect(a.locator('#app')).not.toContainText(CANARY);
    expect(Object.keys(await local(a))).toEqual(['refundReconciler.erased']);
  });
});

test.describe('capture and recovery', () => {
  test('agreement stores no report; capture preview and explicit Save still work afterwards', async ({ granted: session }) => {
    const dash = await session.openDashboard();
    expect(((await decryptedRaw(dash)) as { cases: unknown[] }).cases).toEqual([]);
    await createCase(dash, { orderRef: ORDER_A, items: [{ label: 'Synthetic headphones', amount: '70' }] });
    expect(await storedEntries(session)).toHaveLength(1);
    const { page: source, windowId } = await openSource(session);
    await selectBlock(source, 'issued-70');
    const popup = await openPopup(session, windowId);
    await capture(popup);
    await expect(popup.getByTestId('preview')).toBeVisible();
    expect((await storedEntries(session)).filter((e) => e.kind === 'merchant_report')).toEqual([]);
    await assign(popup, ORDER_A, 'Synthetic headphones');
    await approveAndSave(popup);
    await expect(popup.getByTestId('capture-saved')).toBeVisible();
    const reports = (await storedEntries(session)).filter((e) => e.kind === 'merchant_report');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.capture).toMatchObject({ itemApplicabilityConfirmed: true });
  });

  test('typed erase works while agreement is pending, removes records and receipt, and returns to a fresh disclosure; deferring keeps records', async ({ session }) => {
    const page = await session.openDashboard();
    await createCase(page, { orderRef: 'CONSENT-DEFER', items: [{ label: `${CANARY} fan`, amount: '15' }] });
    const caseId = ((await decryptedRaw(page)) as { cases: { id: string }[] }).cases[0]!.id;
    await setReceipt(session, { format: 'refund-reconciler-consent', formatVersion: 1, dataPracticesVersion: 2, acceptedAt: '2026-10-01T00:00:00.000Z' });
    await expect(consentGate(page)).toHaveAttribute('data-reason', 'obsolete');
    const stored = await local(page);
    // Individual case deletion needs agreement and unlocked records: no control, and the worker refuses it.
    await expect(page.getByRole('button', { name: 'Delete case…' })).toHaveCount(0);
    expect(await sendRaw(page, { kind: 'mutate', command: { type: 'deleteCase', caseId } })).toMatchObject({ ok: false, error: { code: 'consent_required' } });
    expect(await local(page)).toEqual(stored);

    // Deferring and closing keep the records.
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.close();
    const again = await session.openDashboard({ accept: false });
    expect(await local(again)).toEqual(stored);

    // Recovery without agreeing: the typed erase on the disclosure screen.
    await again.getByTestId('consent-erase').getByRole('button', { name: 'Erase stored data…' }).click();
    await expect(again.getByRole('button', { name: 'Permanently erase' })).toBeDisabled();
    await again.getByLabel('Type ERASE to confirm').fill('ERASE');
    await again.getByRole('button', { name: 'Permanently erase' }).click();
    await expect(again.getByTestId('notice')).toContainText('including your agreement');
    await expect(consentGate(again)).toHaveAttribute('data-reason', 'missing');
    expect(Object.keys(await local(again))).toEqual(['refundReconciler.erased']);
    await acceptViaUi(again);
    await expect(vaultScreen(again, 'vault-setup')).toContainText('Stored data was erased');
  });
});

type FaultWindow = Window & {
  __faults?: { accept: 'pass' | 'lose-before-delivery' | 'lose-after-delivery'; unavailableReads: boolean };
};

/**
 * Disclosed fault injection at the page's runtime boundary (test code only):
 * wraps this dashboard's chrome.runtime.sendMessage so that the next
 * acceptDataPractices can be lost before delivery (never sent to the worker) or
 * after delivery (the real worker handles it, the page sees a failure), and so
 * that read replies can be replaced by the valid protocol state
 * storage_unavailable. The worker and storage are real and unchanged.
 */
async function injectFaults(page: Page, faults: NonNullable<FaultWindow['__faults']>): Promise<void> {
  await page.evaluate((f) => {
    const w = window as FaultWindow;
    const first = w.__faults === undefined;
    w.__faults = f;
    if (!first) return;
    const rt = chrome.runtime as unknown as { sendMessage: (m: unknown) => Promise<unknown> };
    const inner = rt.sendMessage.bind(chrome.runtime);
    rt.sendMessage = async (m: unknown) => {
      const kind = (m as { kind?: string } | null)?.kind;
      const cfg = w.__faults!;
      if (kind === 'acceptDataPractices' && cfg.accept !== 'pass') {
        const mode = cfg.accept;
        cfg.accept = 'pass';
        if (mode === 'lose-after-delivery') await inner(m);
        throw new Error('Synthetic lost message');
      }
      if (kind === 'read' && cfg.unavailableReads) return { ok: true, ledger: { status: 'storage_unavailable', error: 'Synthetic storage restriction failure' } };
      return inner(m);
    };
  }, faults);
}

test.describe('uncertain agreement outcomes', () => {
  test('an agreement lost before delivery, then unavailable storage, is never reported as confirmed', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    await injectFaults(page, { accept: 'lose-before-delivery', unavailableReads: true });
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page.getByTestId('vault-unavailable')).toBeVisible();
    const notice = page.getByTestId('notice');
    await expect(notice).toContainText('not confirmed whether your agreement was stored');
    await expect(notice).not.toContainText('confirms it');
    await expect(page.locator('body')).not.toContainText('Your agreement is stored');
    await expect(vaultScreen(page, 'vault-setup')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create case' })).toHaveCount(0);
    expect(await local(page)).toEqual({});
    // Once storage reads normally again, the real state shows the agreement was not stored.
    await injectFaults(page, { accept: 'pass', unavailableReads: false });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(consentGate(page)).toHaveAttribute('data-reason', 'missing');
  });

  test('a definite agreement followed by unavailable storage says it was stored but cannot be checked, without data features', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    await injectFaults(page, { accept: 'pass', unavailableReads: true });
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(page.getByTestId('vault-unavailable')).toBeVisible();
    const notice = page.getByTestId('notice');
    await expect(notice).toContainText('was stored, but this browser’s extension storage can’t be checked right now');
    await expect(notice).toContainText('data features stay unavailable');
    await expect(vaultScreen(page, 'vault-setup')).toHaveCount(0);
    expect(Object.keys(await local(page))).toEqual([CONSENT_KEY]);
    await injectFaults(page, { accept: 'pass', unavailableReads: false });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
  });

  test('a committed agreement whose reply was lost is confirmed only by a fresh read that shows the gate passed', async ({ session }) => {
    const page = await session.openDashboard({ accept: false });
    await injectFaults(page, { accept: 'lose-after-delivery', unavailableReads: false });
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
    await expect(page.getByTestId('notice')).toContainText('the current state confirms it');
    expect(Object.keys(await local(page))).toEqual([CONSENT_KEY]);
  });
});

test.describe('presentation', () => {
  test('keyboard operation, readable light and dark layouts at narrow and desktop widths, and no external resources', async ({ session }) => {
    const external: string[] = [];
    session.context!.on('request', (r) => {
      if (!r.url().startsWith('chrome-extension://')) external.push(r.url());
    });
    const page = await session.openDashboard({ accept: false });
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const size of [{ width: 360, height: 740 }, { width: 375, height: 667 }, { width: 1280, height: 900 }]) {
        await page.setViewportSize(size);
        await page.emulateMedia({ colorScheme });
        // A new navigation (not a reload), so no earlier scroll position is restored.
        await page.goto(session.dashboardUrl);
        const gate = consentGate(page);
        await expect(gate.getByRole('heading', { level: 2 })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${colorScheme} ${size.width}`).toBe(true);
        const colors = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.getElementById('consent-heading')!).color }));
        expect(colors.bg).toBe(colorScheme === 'dark' ? 'rgb(20, 23, 28)' : 'rgb(246, 247, 249)');
        expect(colors.text).not.toBe(colors.bg);
        // The agreement action is reachable by ordinary scrolling.
        const agree = page.getByRole('button', { name: 'Agree and continue' });
        await agree.scrollIntoViewIfNeeded();
        await expect(agree).toBeInViewport();
      }
    }
    expect(await page.evaluate(() => document.querySelectorAll('[src^="http"], [href^="http"], link[rel="stylesheet"][href*="//"]').length)).toBe(0);

    // Keyboard only: Tab to Agree and continue (visible focus), press Enter.
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(session.dashboardUrl);
    let focusedAgree = false;
    for (let i = 0; i < 20 && !focusedAgree; i++) {
      await page.keyboard.press('Tab');
      focusedAgree = await page.evaluate(() => document.activeElement?.id === 'consent-agree');
    }
    expect(focusedAgree).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
    expect(external).toEqual([]);
  });
});
