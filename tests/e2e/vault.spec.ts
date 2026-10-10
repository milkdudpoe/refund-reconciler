// Task 09: the encrypted vault through the built extension's real dashboard,
// popup, service worker, chrome.storage.local/session and a real profile on
// disk. All data is SYNTHETIC. The passphrase is a synthetic test value and is
// never printed; screenshots show synthetic data only.
//
// Disclosed test setup: the "legacy" ledgers below are written straight to the
// plaintext key that versions before 0.7.0 used, as such an installation would
// have left them; tampering writes damaged ciphertext straight to storage.
// Everything else goes through the real UI or the worker's real protocol.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { ExtensionSession, createCase, expect, itemCard, recordForItem, test } from './fixtures';
import { clipboardCalls, countDownloads, gateClipboard, holdNextRead, openSummary, releaseHeldRead, restoreClipboard, waitForHeldRead } from './export-helpers';
import { holdNextReply, releaseSend, saveBackupDownload, scratchDir, sendRaw, waitForHeldSend } from './restore-helpers';
import { LEGACY_KEY, TEST_PHRASE, VAULT_KEY, decryptedRaw, eraseTyped, fillNewPassphrase, ledgerStatus, migrateViaUi, setupViaUi, unlockViaUi, vaultScreen } from './vault-helpers';
import { richLegacyLedger } from '../shared/rich-ledger';

const CANARY = 'SYNTHETIC-CANARY-7f3a9c';
const SHOTS = join(import.meta.dirname, '../../test-results/vault-screens');

/** Counts this page's tab look-ups and script injections (installed before any page script runs). */
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

async function openPopupPage(session: ExtensionSession): Promise<Page> {
  const popup = await session.context!.newPage();
  await popup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  return popup;
}

/** Every file under a folder, recursively. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (e.isFile()) out.push(join(e.parentPath, e.name));
  }
  return out;
}

/** Which of these files contain the needle, as UTF-8 or UTF-16LE bytes. */
async function filesContaining(files: string[], needle: string): Promise<string[]> {
  const encodings = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')];
  const hits: string[] = [];
  for (const f of files) {
    if ((await stat(f)).size > 200 * 1024 * 1024) continue;
    const data = await readFile(f).catch(() => null);
    if (data && encodings.some((e) => data.includes(e))) hits.push(f);
  }
  return hits;
}

test('fresh install: “Protect your records” comes first, explains the limits, validates the passphrase and clears it', async ({ session }) => {
  const page = await session.openDashboard({ unlock: false });
  const setup = vaultScreen(page, 'vault-setup');
  await expect(setup.getByRole('heading', { name: 'Protect your records' })).toBeVisible();
  // Nothing that creates, restores or loads data exists yet.
  for (const name of ['Create case', 'Load synthetic demo', 'Restore from JSON…', 'Restore from a JSON backup…', 'Download all data (JSON)…']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  expect(await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'mutate', command: { type: 'loadDemo' } }))).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
  const explain = page.getByTestId('vault-explain');
  await expect(explain).toContainText('stays in this browser profile');
  await expect(explain).toContainText('after Chrome restarts, after the extension is reloaded or updated, and after you choose Lock now');
  await expect(page.getByTestId('vault-no-recovery')).toContainText('There is no recovery service');
  await expect(explain).toContainText('JSON backups, case summaries and anything you copy to the clipboard are not encrypted');
  await expect(explain).toContainText('while they are unlocked in this browser, against malware');
  await expect(page.locator('#vault-rules')).toContainText('at least 12 characters');
  await expect(page.locator('#vault-rules')).toContainText('nothing is trimmed');
  await page.screenshot({ path: join(SHOTS, 'setup.png'), fullPage: true });

  // Too short (11 code points), then mismatched, then no acknowledgment: each blocks with a useful error.
  const pass = page.getByLabel('Passphrase', { exact: true });
  const again = page.getByLabel('Type the passphrase again');
  await pass.fill('elevenchars');
  await again.fill('elevenchars');
  await page.getByRole('button', { name: 'Protect my records' }).click();
  await expect(page.locator('#vault-new-error')).toContainText('at least 12 characters');
  await expect(pass).toBeFocused();
  await pass.fill(TEST_PHRASE);
  await again.fill(`${TEST_PHRASE} `);
  await page.getByRole('button', { name: 'Protect my records' }).click();
  await expect(page.locator('#vault-confirm-error')).toContainText('not the same');
  await again.fill(TEST_PHRASE);
  await page.getByRole('button', { name: 'Protect my records' }).click();
  await expect(page.locator('#vault-ack-error')).toContainText('no recovery');
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});

  // Show/hide is a real toggle of the input type.
  await expect(pass).toHaveAttribute('type', 'password');
  await page.getByLabel('Show passphrase').check();
  await expect(pass).toHaveAttribute('type', 'text');
  await page.getByLabel('Show passphrase').uncheck();
  await expect(pass).toHaveAttribute('type', 'password');

  await page.getByRole('checkbox', { name: /cannot be recovered except from a plaintext backup/ }).check();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Protect my records' }).click();
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible({ timeout: 15_000 });
  console.info(`Browser setup (UI click to unlocked dashboard): ${Date.now() - t0} ms`);
  await expect(page.getByTestId('notice')).toContainText('protected and unlocked');
  await expect(page.locator('#list-heading')).toBeFocused();
  await expect(page.getByTestId('lockbar')).toContainText('Saved records are encrypted');
  // The page keeps no copy of the phrase: the (persistent) fields are empty and nothing stored contains it.
  expect(await page.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox])')].map((i) => (i as HTMLInputElement).value).filter(Boolean))).toEqual([]);
  expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toContain(TEST_PHRASE);
  expect(JSON.stringify(await page.evaluate(() => chrome.storage.session.get(null)))).not.toContain(TEST_PHRASE);
});

test('a canary typed through the real UI is never in persistent storage or extension storage files, and neither is the key', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: `${CANARY}-ORDER`, items: [{ label: `${CANARY} kettle`, amount: '42.00' }] });
  await recordForItem(page, `${CANARY} kettle`, 'Confirm money received', '12.00', { note: `${CANARY} note`, reference: `${CANARY}-REF` });
  // Current persistent storage: only the vault envelope, no plaintext.
  const local = await page.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(local)).toEqual([VAULT_KEY]);
  expect(JSON.stringify(local)).not.toContain(CANARY);
  expect(JSON.stringify(await decryptedRaw(page))).toContain(`${CANARY} note`);
  // The unwrapped key lives only in session (memory) storage while unlocked.
  const record = (await page.evaluate(() => chrome.storage.session.get('refundReconciler.session')))['refundReconciler.session'] as { key: string };
  const keyB64 = record.key;
  const keyHex = Buffer.from(keyB64, 'base64').toString('hex');
  const vaultJson = JSON.stringify(local[VAULT_KEY]);
  expect(vaultJson).not.toContain(keyB64);
  const extensionId = session.extensionId;
  await session.close();

  // Closed browser: the profile's extension storage files (chrome.storage.local LevelDB, extension state, and any
  // extension-origin web storage) contain neither the canary, nor the key in base64 or hex, nor the passphrase.
  const profile = join(session.userDataDir, 'Default');
  const extensionFiles = [
    ...(await filesUnder(join(profile, 'Local Extension Settings', extensionId))),
    ...(await filesUnder(join(profile, 'Extension State'))),
    ...(await filesUnder(join(profile, 'IndexedDB'))).filter((f) => f.includes(extensionId)),
    ...(await filesUnder(join(profile, 'Local Storage'))),
  ];
  expect(extensionFiles.length).toBeGreaterThan(0);
  const vaultFiles = await filesContaining(extensionFiles, (local[VAULT_KEY] as { payload: { iv: string } }).payload.iv);
  expect(vaultFiles.length, 'the ciphertext is really in these files').toBeGreaterThan(0);
  for (const needle of [CANARY, keyB64, keyHex, TEST_PHRASE]) expect(await filesContaining(extensionFiles, needle)).toEqual([]);
  // The key and the passphrase are nowhere in the whole profile on disk.
  const everything = await filesUnder(session.userDataDir);
  for (const needle of [keyB64, keyHex]) expect(await filesContaining(everything, needle)).toEqual([]);
  const phraseAnywhere = await filesContaining(everything, TEST_PHRASE);
  const canaryAnywhere = await filesContaining(everything, CANARY);
  // Reported, not asserted: Chrome's own files (e.g. session restore of typed form text) are outside the extension's control.
  console.info(`Whole-profile scan after close: passphrase in ${phraseAnywhere.length} file(s), canary in ${canaryAnywhere.length} file(s) outside extension storage: ${canaryAnywhere.map((f) => f.slice(session.userDataDir.length)).join(', ') || 'none'}`);
  expect(phraseAnywhere).toEqual([]);
});

test('Lock now in one view promptly clears every open dashboard and the popup; later reads and writes are refused', async ({ session }) => {
  const a = await session.openDashboard();
  await createCase(a, { orderRef: 'LOCK-1', items: [{ label: `${CANARY} lamp`, amount: '30' }] });
  // View A: case open with an entry draft and a prepared summary panel.
  await openSummary(a);
  await itemCard(a, `${CANARY} lamp`).getByRole('button', { name: 'Confirm money received' }).click();
  await a.getByTestId('entry-form').getByLabel('Note (optional)').fill(`${CANARY} draft`);
  // View B: the list with a search typed. View C: the toolbar popup.
  const b = await session.openDashboard();
  await b.getByLabel('Search by order reference or item description').fill('LOCK');
  const popup = await openPopupPage(session);
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toBeVisible();

  await b.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(b, 'vault-locked')).toBeVisible();
  await expect(b.getByTestId('notice')).toContainText('Locked.');
  for (const p of [a, b]) {
    await expect(vaultScreen(p, 'vault-locked')).toBeVisible();
    await expect(p.getByTestId('export-panel')).toHaveCount(0);
    await expect(p.getByTestId('entry-form')).toHaveCount(0);
    await expect(p.locator('#app')).not.toContainText(CANARY);
    await expect(p.locator('#app')).not.toContainText('LOCK-1');
    expect(await p.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]), textarea')].map((i) => (i as HTMLInputElement).value).filter(Boolean))).toEqual([]);
  }
  await expect(popup.getByTestId('popup-locked')).toContainText('Your records are locked');
  await expect(popup.getByRole('button', { name: 'Open dashboard to unlock' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toHaveCount(0);
  await a.screenshot({ path: join(SHOTS, 'locked.png'), fullPage: true });

  expect(await ledgerStatus(a)).toBe('locked');
  expect(await sendRaw(a, { kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'vault_locked' } });
  expect(await a.evaluate(() => chrome.storage.session.get(null))).not.toHaveProperty('refundReconciler.session');

  // A wrong passphrase: honest retry message, field cleared, still locked.
  await a.getByLabel('Passphrase', { exact: true }).fill('synthetic wrong phrase 9');
  await a.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(a.getByTestId('vault-feedback')).toContainText('cannot be told apart');
  await expect(a.getByLabel('Passphrase', { exact: true })).toHaveValue('');
  await expect(a.getByLabel('Passphrase', { exact: true })).toBeFocused();
  expect(await ledgerStatus(a)).toBe('locked');

  const t0 = Date.now();
  await unlockViaUi(a);
  console.info(`Browser unlock (UI click to unlocked dashboard): ${Date.now() - t0} ms`);
  // Every view follows the unlock; nothing typed before the lock came back.
  await expect(b.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  await expect(b.getByLabel('Search by order reference or item description')).toHaveValue('');
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toBeVisible();
});

test('work started before Lock cannot repopulate the page, start a download or write the clipboard', async ({ session }) => {
  const a = await session.openDashboard();
  await createCase(a, { orderRef: 'STALE-1', items: [{ label: 'Synthetic stale item', amount: '10' }] });
  const b = await session.openDashboard();
  const downloads = countDownloads(a);

  // Copy pressed, its action-time check held; then Lock in another view: no clipboard write happens.
  await openSummary(a);
  await gateClipboard(a);
  await holdNextRead(a);
  await a.getByRole('button', { name: 'Copy text' }).click();
  await waitForHeldRead(a);
  await b.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
  await releaseHeldRead(a);
  await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
  expect((await clipboardCalls(a)).calls).toBe(0);
  await restoreClipboard(a);

  // Download pressed, its check held; then Lock: no download starts.
  await unlockViaUi(b);
  await expect(a.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(a.getByRole('button', { name: 'Download JSON', exact: true })).toBeEnabled();
  await holdNextRead(a);
  await a.getByRole('button', { name: 'Download JSON', exact: true }).click();
  await waitForHeldRead(a);
  await b.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
  await releaseHeldRead(a);
  await a.waitForTimeout(300);
  expect(downloads.count).toBe(0);
  await expect(a.getByTestId('export-panel')).toHaveCount(0);

  // A change committed before Lock (reply held) is reported truthfully, and does not reopen anything.
  await unlockViaUi(b);
  await a.getByTestId('case-row').click();
  await holdNextReply(a);
  await recordForItemNoWait(a, 'Synthetic stale item', '4.00');
  await waitForHeldSend(a);
  await b.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
  await releaseSend(a);
  await expect(a.getByTestId('notice')).toContainText('saved before your records were locked');
  await expect(vaultScreen(a, 'vault-locked')).toBeVisible();
  await expect(a.locator('#app')).not.toContainText('Synthetic stale item');
  await unlockViaUi(a);
  await a.getByTestId('case-row').click();
  await expect(a.getByTestId('timeline-entry').filter({ hasText: 'You confirmed $4.00 received' })).toHaveCount(1);
});

async function recordForItemNoWait(page: Page, label: string, amount: string): Promise<void> {
  await itemCard(page, label).getByRole('button', { name: 'Confirm money received' }).click();
  await page.getByTestId('entry-form').getByRole('textbox', { name: /USD/ }).fill(amount);
  await page.getByTestId('entry-form').getByRole('button', { name: 'Save' }).click();
}

test('a service-worker restart keeps the records unlocked; a full browser restart locks them and the popup reads nothing', async ({ session }) => {
  await instrumentTabAccess(session.context!);
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'RESTART-1', items: [{ label: 'Synthetic radio', amount: '25' }] });

  // Stop the real service worker (as Chrome does when it is idle); the next request starts a new one.
  // Chrome's own (DevTools protocol) view of this worker's running status.
  const cdp = await session.context!.newCDPSession(page);
  const statuses: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: { scriptURL: string; runningStatus: string }[] }) => {
    for (const v of e.versions) if (v.scriptURL.startsWith(`chrome-extension://${session.extensionId}/`)) statuses.push(v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');
  // The next request starts the worker again (a new instance with no memory of the key); it is still unlocked.
  expect(await ledgerStatus(page)).toBe('ok');
  await expect.poll(() => statuses.at(-1)).toBe('running');
  expect(statuses.lastIndexOf('stopped')).toBeLessThan(statuses.lastIndexOf('running'));
  await page.reload();
  await expect(page.getByTestId('case-row')).toContainText('RESTART-1');

  // Full browser restart: locked again; the popup only offers to open the dashboard and touches no tab.
  await session.close();
  await session.launch();
  await instrumentTabAccess(session.context!);
  const popup = await openPopupPage(session);
  await expect(popup.getByTestId('popup-locked')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Open dashboard to unlock' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toHaveCount(0);
  await popup.waitForTimeout(300);
  expect(await tabAccess(popup)).toEqual([]);
  await popup.close();

  const dash = await session.openDashboard({ unlock: false });
  await expect(vaultScreen(dash, 'vault-locked')).toBeVisible();
  await unlockViaUi(dash);
  await expect(dash.getByTestId('case-row')).toContainText('RESTART-1');
  // Once unlocked, the popup may look up its tab (once), as before.
  const popup2 = await openPopupPage(session);
  await expect(popup2.getByRole('button', { name: 'Capture selected refund text' })).toBeVisible();
  await expect.poll(() => tabAccess(popup2)).toEqual(['tabs.query']);
});

test('damaged ciphertext or a damaged wrapped key is never reset; erase is available while locked and an old session is refused', async ({ session }) => {
  let page = await session.openDashboard();
  await createCase(page, { orderRef: 'DAMAGE-1', items: [{ label: 'Synthetic fan', amount: '15' }] });
  const vault = (await page.evaluate(() => chrome.storage.local.get('refundReconciler.vault')))[VAULT_KEY] as { vaultId: string; keyWrap: { wrappedKey: string }; payload: { ciphertext: string } };
  const oldSession = (await page.evaluate(() => chrome.storage.session.get('refundReconciler.session')))['refundReconciler.session'];
  const flip = (b64: string) => `${b64[0] === 'A' ? 'B' : 'A'}${b64.slice(1)}`;
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(page, 'vault-locked')).toBeVisible();

  // Damaged payload: the right passphrase opens the key, the records are unreadable, nothing is reset.
  await page.evaluate((v) => chrome.storage.local.set({ 'refundReconciler.vault': v }), { ...vault, payload: { ...vault.payload, ciphertext: flip(vault.payload.ciphertext) } });
  await page.getByLabel('Passphrase', { exact: true }).fill(TEST_PHRASE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('vault-feedback')).toContainText('damaged or unreadable');
  await expect(page.getByTestId('vault-feedback')).toContainText('no new ledger was created');
  expect(await ledgerStatus(page)).toBe('locked');

  // Damaged wrapped key: indistinguishable from a wrong passphrase.
  await page.evaluate((v) => chrome.storage.local.set({ 'refundReconciler.vault': v }), { ...vault, keyWrap: { ...vault.keyWrap, wrappedKey: flip(vault.keyWrap.wrappedKey) } });
  await page.getByLabel('Passphrase', { exact: true }).fill(TEST_PHRASE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByTestId('vault-feedback')).toContainText('did not unlock your records');
  await expect(page.getByTestId('vault-feedback')).toContainText('cannot be told apart');

  // An unsupported envelope (e.g. an absurd work factor) is refused before any key derivation.
  await page.evaluate((v) => chrome.storage.local.set({ 'refundReconciler.vault': v }), { ...vault, kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations: 2 ** 31, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' } });
  await expect(vaultScreen(page, 'vault-unreadable')).toContainText('unsupported version');
  await page.evaluate((v) => chrome.storage.local.set({ 'refundReconciler.vault': v }), vault);
  await expect(vaultScreen(page, 'vault-locked')).toBeVisible();

  // Forgot the passphrase: typed erase from the locked screen.
  await eraseTyped(page);
  await expect(page.getByText('Stored data was erased.')).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({ 'refundReconciler.erased': expect.objectContaining({ format: 'refund-reconciler-erased' }) });
  await setupViaUi(page, 'a new synthetic phrase 02');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  // The pre-erase session record, even if put back, never opens the new vault.
  await page.evaluate((rec) => chrome.storage.session.set({ 'refundReconciler.session': rec }), oldSession);
  expect(await ledgerStatus(page)).toBe('locked');
  page = await session.openDashboard({ unlock: false });
  await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
  await unlockViaUi(page, 'a new synthetic phrase 02');
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('an earlier version’s plaintext ledger: backup first, everything else blocked, migration preserves it exactly', async ({ session }) => {
  await instrumentTabAccess(session.context!);
  const scratch = await scratchDir();
  try {
    let page = await session.openDashboard({ unlock: false });
    const legacy = richLegacyLedger();
    await page.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, legacy] as const);
    await page.reload();
    const screen = vaultScreen(page, 'vault-migrate');
    await expect(screen.getByRole('heading', { name: 'Protect your existing records' })).toBeVisible();
    await expect(screen).toContainText(`saved ${legacy.cases.length} cases in this browser without encryption`);
    await expect(screen).toContainText('cannot remove older plaintext copies');
    for (const name of ['Create case', 'Load synthetic demo', 'Restore from JSON…', 'Lock now']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'migrate.png'), fullPage: true });

    // The popup neither reads the tab nor offers capture while migration is pending.
    const popup = await openPopupPage(session);
    await expect(popup.getByRole('button', { name: 'Open dashboard to protect your records' })).toBeVisible();
    await popup.waitForTimeout(300);
    expect(await tabAccess(popup)).toEqual([]);
    await popup.close();

    // The read-only exception: a complete plaintext format-1 backup of the validated legacy ledger.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click()]);
    const path = join(scratch.dir, dl.suggestedFilename());
    await dl.saveAs(path);
    const backup = JSON.parse(await readFile(path, 'utf8'));
    expect(backup).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(backup.store).toEqual(legacy);
    expect(JSON.stringify(backup)).not.toMatch(/vault|refund-reconciler-session|kdf/);
    await expect(page.getByTestId('vault-feedback')).toContainText('ordinary, unencrypted JSON file');
    // Changes are blocked at the worker too, and nothing was written by the backup.
    expect(await sendRaw(page, { kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });
    expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({ [LEGACY_KEY]: legacy });

    await migrateViaUi(page);
    await expect(page.getByTestId('notice')).toContainText('existing records are now encrypted');
    // Exactly the same ledger, now only inside the vault; the plaintext key is gone.
    const local = await page.evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(local)).toEqual([VAULT_KEY]);
    expect(JSON.stringify(local)).not.toContain('PRIVATE-NOTE-RESTORE');
    expect(await decryptedRaw(page)).toEqual(legacy);
    await expect(page.getByTestId('case-row')).toHaveCount(legacy.cases.length);
    // New writes are encrypted and continue the same history.
    await page.getByRole('button', { name: 'Remove synthetic demo' }).click();
    await expect(page.getByTestId('demo-cases')).toHaveCount(0);
    expect(((await decryptedRaw(page)) as { revision: number }).revision).toBe(legacy.revision + 1);
    expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toContain('Synthetic chair');

    // A restart requires the passphrase chosen for the migration.
    await session.close();
    await session.launch();
    page = await session.openDashboard({ unlock: false });
    await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
    await unlockViaUi(page);
    await expect(page.getByTestId('case-row')).toHaveCount(legacy.cases.length - 2);
  } finally {
    await scratch.cleanup();
  }
});

test('a migration whose verification could not finish stays blocked with the original intact until the passphrase finishes it', async ({ session }) => {
  const page = await session.openDashboard({ unlock: false });
  const legacy = richLegacyLedger();
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, legacy] as const);
  await page.reload();
  await expect(vaultScreen(page, 'vault-migrate')).toBeVisible();
  // Fault injection in the real worker: its read-back of the candidate fails once.
  const worker = session.context!.serviceWorkers().at(-1)!;
  await worker.evaluate(() => {
    const area = chrome.storage.local as unknown as { get: (k: unknown) => Promise<Record<string, unknown>>; set: (i: Record<string, unknown>) => Promise<void> };
    const realGet = area.get.bind(chrome.storage.local);
    const realSet = area.set.bind(chrome.storage.local);
    let vaultWritten = false;
    area.set = (items) => {
      if ('refundReconciler.vault' in items) vaultWritten = true;
      return realSet(items);
    };
    area.get = (keys) => {
      if (vaultWritten && Array.isArray(keys) && keys.length === 3) {
        area.get = realGet;
        area.set = realSet;
        return Promise.reject(new Error('Simulated read-back failure'));
      }
      return realGet(keys);
    };
  });
  await fillNewPassphrase(page);
  await page.getByRole('button', { name: 'Encrypt my existing records' }).click();
  await expect(vaultScreen(page, 'vault-pending')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('notice').or(page.getByTestId('vault-feedback'))).toContainText('could not be read back');
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  expect(stored[LEGACY_KEY]).toEqual(legacy);
  expect(stored['refundReconciler.migration']).toMatchObject({ phase: 'candidate' });
  expect(await sendRaw(page, { kind: 'mutate', command: { type: 'loadDemo' } })).toMatchObject({ ok: false, error: { code: 'vault_not_ready' } });

  // After a restart it is still pending (never assumed complete); the passphrase checks and finishes it.
  await session.close();
  await session.launch();
  const again = await session.openDashboard({ unlock: false });
  await expect(vaultScreen(again, 'vault-pending')).toBeVisible();
  await again.getByLabel('Passphrase', { exact: true }).fill(TEST_PHRASE);
  await again.getByRole('button', { name: 'Check and finish' }).click();
  await expect(again.getByRole('heading', { name: 'Your cases' })).toBeVisible({ timeout: 15_000 });
  expect(Object.keys(await again.evaluate(() => chrome.storage.local.get(null)))).toEqual([VAULT_KEY]);
  expect(await decryptedRaw(again)).toEqual(legacy);
});

test('a backup of an earlier version restores into a new encrypted installation only after setup', async ({ session }) => {
  const scratch = await scratchDir();
  try {
    const page = await session.openDashboard({ unlock: false });
    await expect(page.getByRole('button', { name: 'Restore from a JSON backup…' })).toHaveCount(0);
    await setupViaUi(page);
    const legacy = richLegacyLedger();
    const file = join(scratch.dir, 'earlier-version-backup.json');
    await (await import('node:fs/promises')).writeFile(file, `${JSON.stringify({ format: 'refund-reconciler-backup', formatVersion: 1, exportedAt: '2026-10-09T08:00:00.000Z', store: legacy }, null, 2)}\n`);
    await page.getByRole('button', { name: 'Restore from a JSON backup…' }).click();
    await page.getByLabel('Backup file (.json)').setInputFiles(file);
    await expect(page.getByTestId('restore-destination')).toHaveAttribute('data-state', 'eligible');
    await page.locator('#restore-approve').click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const restored = (await decryptedRaw(page)) as { cases: unknown[]; ledgerEpoch: string; lastRestore: { sourceRevision: number } };
    expect(restored.cases).toEqual(legacy.cases);
    expect(restored.ledgerEpoch).not.toBe(legacy.ledgerEpoch);
    expect(restored.lastRestore.sourceRevision).toBe(legacy.revision);
    expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toContain('PRIVATE-NOTE-RESTORE');
    // Its own backup is again plaintext format 1, with no key material or vault metadata.
    await page.locator('#restore-cancel').click();
    await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
    const saved = await saveBackupDownload(page, scratch.dir);
    const text = await readFile(saved.path, 'utf8');
    expect(JSON.parse(text).store.cases).toEqual(legacy.cases);
    expect(text).not.toMatch(/refund-reconciler-vault|wrappedKey|ciphertext|refund-reconciler-session/);
    expect(text).not.toContain(TEST_PHRASE);
  } finally {
    await scratch.cleanup();
  }
});
