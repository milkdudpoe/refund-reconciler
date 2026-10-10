// Same-installation update checks: each earlier production version (0.5.0,
// 0.6.0 and 0.7.0, built from their own source at pinned commits; see
// baseline.ts) is loaded from one stable temporary folder, given a rich
// synthetic ledger (plaintext before 0.7.0, encrypted in 0.7.0), and then
// updated in place to the current version by replacing that folder's files
// with the contents of the real beta ZIP and reloading the extension. The
// current version must first show its data practices and require Agree and
// continue, changing nothing until then; it must then migrate a plaintext
// ledger into its encrypted vault, or unlock the 0.7.0 vault with its existing
// passphrase, without losing or changing anything. Run with
// `npm run test:update`.
//
// Only temporary folders and profiles created here are used, and all data is
// synthetic. Nothing is added to the production package: the beta ZIP is
// extracted unchanged, and each baseline is built with its own production
// build from its own lockfile.
//
// Data setup (disclosed): the rich ledger is constructed by test code
// (tests/shared/rich-ledger.ts) and written to a backup file, then loaded into
// the baseline through the baseline's own "Restore from JSON…" UI. Before
// that, a corrupt value is written directly to the 0.5.0/0.6.0 plaintext key
// only to reach the baseline's own "Erase stored data…" control (0.7.0 offers
// it on its locked screen), so the ledger carries an erase marker (ledgerEpoch)
// as well as a restore receipt. One further case is then created entirely
// through the baseline's UI. After the update, the agreement, migration, unlock
// and restore happen through the current UI; a read-only recorder in the
// service worker logs the order of its storage calls (it changes nothing).
//
// Developer mode is switched on in the test's own temporary profile through
// that profile's chrome://extensions switch, as a tester does before "Load
// unpacked"; Chromium refuses to reload an unpacked extension without it.
//
// What this does not cover: Chrome's own "Load unpacked" registration and the
// reload button in chrome://extensions (Playwright loads the folder with
// --load-extension and reloads with chrome.runtime.reload()), and installed
// desktop Chrome (this runs Playwright's bundled Chromium). See docs/beta.md.

import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test, type Page, type Worker } from '@playwright/test';
import { PARSER_VERSION, analyzeExcerpt } from '../../src/capture/parse';
import { buildOverview, realCaseViews } from '../../src/domain/overview';
import { summarizeCase } from '../../src/domain/reconcile';
import type { StoreData } from '../../src/domain/types';
import { parseStore } from '../../src/domain/validate';
import { isRegularFileEntry, isSafeEntryName, readZip } from '../../scripts/beta/zip.ts';
import { ExtensionSession, createCase, expect, itemCard, recordForItem } from '../e2e/fixtures';
import { approveButton, chooseBackup, destination, envelopeOf, expectEligible, openRestore, saveBackupDownload, writeBackupFile } from '../e2e/restore-helpers';
import { CONSENT_KEY, LEGACY_KEY, VAULT_KEY, acceptViaUi, consentGate, decryptedRaw, migrateViaUi, setupViaUi, storedRecords, unlockViaUi, vaultScreen } from '../e2e/vault-helpers';
import { HISTORICAL_REFUSED_EXCERPT, richLedger } from '../shared/rich-ledger';
import { BASELINE_050, BASELINE_060, BASELINE_070, buildBaseline, exportBaselineSource, type Baseline } from './baseline';

const ROOT = resolve(import.meta.dirname, '../..');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const ZIP = join(ROOT, 'artifacts', 'beta', `refund-reconciler-beta-${VERSION}.zip`);
const CORRUPT = { schemaVersion: 1, revision: 1, cases: [{ id: 'c', amountCents: 1.5 }] };
/** One passphrase per run, chosen in the current version's UI (synthetic, never printed). */
const PHRASE = 'synthetic update passphrase 0001';

type Raw = StoreData & Record<string, unknown>;

let work = '';
const built = new Map<string, string>();
/** Every browser session this file starts; all are closed before the work folder is removed. */
const sessions = new Set<ExtensionSession>();

test.beforeAll(async () => {
  test.setTimeout(600_000);
  work = await mkdtemp(join(tmpdir(), 'refund-reconciler-update-'));
  for (const b of [BASELINE_050, BASELINE_060, BASELINE_070]) built.set(b.version, await buildBaseline(await exportBaselineSource(work, b), b));
});

test.afterAll(async () => {
  // Runs after a failed test too. Close every browser first (a running Chromium
  // keeps its profile files locked on Windows); a close error never replaces the
  // test's own failure, and the work folder is removed only after all closes settle.
  await Promise.allSettled([...sessions].map((s) => s.close()));
  sessions.clear();
  if (work && !process.env.KEEP_UPDATE_CHECK_FILES) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A session registered for guaranteed teardown before it is launched (so a partly failed launch is closed too). */
function trackedSession(userDataDir: string, extensionDir: string): ExtensionSession {
  const session = new ExtensionSession(userDataDir, extensionDir);
  sessions.add(session);
  return session;
}

/**
 * Turns on Developer mode in this test's own profile through its real
 * chrome://extensions switch (idempotent), and checks the effective setting
 * on a freshly loaded extensions page. Chromium reloads an unpacked extension
 * from disk only with Developer mode on, as for a tester using "Load
 * unpacked"; a value written into the Preferences file is not reliably
 * applied (it is ignored on Windows).
 */
async function ensureDeveloperMode(session: ExtensionSession): Promise<void> {
  const page = await session.context!.newPage();
  try {
    await page.goto('chrome://extensions');
    const toggle = page.getByRole('button', { name: 'Developer mode' });
    await expect(toggle).toHaveAttribute('aria-pressed', /^(true|false)$/);
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Developer mode' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await page.close();
  }
}

function asStore(raw: unknown): StoreData {
  const p = parseStore(raw);
  if (p.status !== 'ok') throw new Error(`stored ledger is ${p.status}`);
  return p.store;
}

/** The baseline's plaintext ledger value, exactly as stored. */
async function legacyRaw(page: Page): Promise<unknown> {
  return (await page.evaluate((key) => chrome.storage.local.get(key), LEGACY_KEY))[LEGACY_KEY];
}

/** Extracts the real beta ZIP, entry by entry, into a new folder. */
async function extractZip(zip: Buffer, into: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of readZip(zip)) {
    expect(isSafeEntryName(entry.name), entry.name).toBe(true);
    expect(isRegularFileEntry(entry), entry.name).toBe(true);
    const target = resolve(into, ...entry.name.split('/'));
    expect(target.startsWith(into + sep)).toBe(true);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    names.push(entry.name);
  }
  return names.sort();
}

/** Lists every file under a folder as forward-slash relative paths. */
async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split(sep).join('/'))
    .sort();
}

/** What the dashboard itself calculates and shows: overview, every case row, and each case's summary and items. */
async function uiState(page: Page): Promise<Record<string, unknown>> {
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  const overview = await page.getByTestId('overview').innerText();
  const rows = await page.getByTestId('case-row').allInnerTexts();
  const cases: Record<string, unknown>[] = [];
  for (let i = 0; i < rows.length; i++) {
    await page.getByTestId('case-row').nth(i).click();
    await expect(page.getByTestId('case-summary')).toBeVisible();
    cases.push({
      heading: await page.locator('#case-heading').innerText(),
      summary: await page.getByTestId('case-summary').innerText(),
      items: await page.getByTestId('item').allInnerTexts(),
      timeline: await page.getByTestId('timeline-entry').allInnerTexts(),
    });
    await page.getByRole('button', { name: '← All cases' }).click();
    await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  }
  return { overview, rows, cases };
}

/** The newest running service worker of this extension. */
function workerOf(session: ExtensionSession): Worker {
  const w = session.context!.serviceWorkers().filter((s) => s.url().startsWith(`chrome-extension://${session.extensionId}/`)).at(-1);
  if (!w) throw new Error('no extension service worker');
  return w;
}

async function downloadBackup(page: Page, dir: string): Promise<{ path: string; envelope: Record<string, unknown> & { store: unknown } }> {
  await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  const saved = await saveBackupDownload(page, dir);
  await page.locator('#export-close').click();
  return { path: saved.path, envelope: JSON.parse(await readFile(saved.path, 'utf8')) };
}

/** Records (does not change) the order of the worker's chrome.storage.local calls. */
async function recordWorkerStorage(w: Worker): Promise<void> {
  await w.evaluate(() => {
    const g = globalThis as unknown as { __ops: string[] };
    g.__ops = [];
    const area = chrome.storage.local as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    for (const fn of ['get', 'set', 'remove'] as const) {
      const real = area[fn]!.bind(chrome.storage.local);
      area[fn] = (...args: unknown[]) => {
        const a = args[0];
        const keys = fn === 'set' ? Object.keys(a as object) : Array.isArray(a) ? (a as string[]) : [String(a)];
        g.__ops.push(`${fn}(${keys.map((k) => k.replace('refundReconciler.', '')).join(',')})`);
        return real(...args);
      };
    }
  });
}

/** The baseline's own erase, reached through a deliberately corrupt plaintext value (as in its own tests). */
async function baselineEraseViaUi(page: Page): Promise<void> {
  await page.evaluate(([k, v]) => chrome.storage.local.set({ [k as string]: v }), [LEGACY_KEY, CORRUPT] as const);
  await expect(page.getByTestId('unreadable')).toBeVisible();
  await page.getByRole('button', { name: 'Erase stored data…' }).click();
  await page.getByRole('button', { name: 'Permanently erase' }).click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
}

/**
 * Replaces every file in the installed folder with the extracted beta ZIP and
 * reloads the unpacked extension from disk, as the reload button in
 * chrome://extensions does. The installation (its id and profile) stays the same.
 */
async function replaceWithBetaZip(session: ExtensionSession, base: string, installed: string): Promise<void> {
  const extensionId = session.extensionId;
  await test.step('replace the installed folder with the extracted beta ZIP and reload the extension', async () => {
    const zip = await readFile(ZIP).catch(() => {
      throw new Error(`${ZIP} is missing; run \`npm run package:beta\` first.`);
    });
    const extracted = join(base, 'beta-extracted');
    const zipFiles = await extractZip(zip, extracted);
    for (const name of await readdir(installed)) await rm(join(installed, name), { recursive: true, force: true });
    await cp(extracted, installed, { recursive: true });
    expect(await listFiles(installed)).toEqual(zipFiles);

    const before = workerOf(session);
    const next = session.context!.waitForEvent('serviceworker', { predicate: (w) => w !== before && w.url().startsWith(`chrome-extension://${extensionId}/`), timeout: 30_000 });
    // Settled even if a step below fails first (it is still awaited and reported below).
    next.catch(() => undefined);
    // Reload the unpacked extension from disk, as the reload button in chrome://extensions does.
    await before.evaluate(() => setTimeout(() => chrome.runtime.reload(), 50));
    const worker = await next;
    await expect.poll(() => worker.evaluate(() => typeof chrome.storage?.local), { timeout: 10_000 }).toBe('object');
    expect(new URL(worker.url()).host).toBe(extensionId);
    expect(await worker.evaluate(() => chrome.runtime.getManifest().version)).toBe(VERSION);
  });
}

/**
 * The updated installation before agreement: the data practices come first,
 * the popup offers only the dashboard, direct requests are refused, and Not
 * now changes nothing. Every stored byte is exactly as the baseline left it.
 */
async function expectGatedAfterUpdate(session: ExtensionSession, page: Page, before: Record<string, unknown>, refused: Record<string, unknown>): Promise<void> {
  const loaded = await page.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() }));
  expect(loaded.manifest.version).toBe(VERSION);
  expect(loaded.manifest.permissions).toEqual(['storage', 'activeTab', 'scripting']);
  expect(loaded.manifest.host_permissions ?? []).toEqual([]);
  await expect(consentGate(page)).toHaveAttribute('data-reason', 'missing');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create case' })).toHaveCount(0);
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual(before);

  const popup = await session.context!.newPage();
  await popup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await expect(popup.getByTestId('popup-locked')).toHaveAttribute('data-state', 'consent_required');
  await popup.close();

  expect(await page.evaluate((m) => chrome.runtime.sendMessage(m), refused)).toMatchObject({ ok: false, error: { code: 'consent_required' } });
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByTestId('consent-deferred')).toBeVisible();
  await page.reload();
  await expect(consentGate(page)).toBeVisible();
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual(before);
}

/** The agreement just given through the UI: nonprivate metadata only. */
async function expectReceipt(page: Page): Promise<unknown> {
  const receipt = (await page.evaluate((k) => chrome.storage.local.get(k), CONSENT_KEY))[CONSENT_KEY];
  expect(receipt).toEqual({ format: 'refund-reconciler-consent', formatVersion: 1, dataPracticesVersion: 1, acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  return receipt;
}

/** Recovery: the baseline's own backup restores into a separate, empty profile running the extracted beta ZIP, after agreement there. */
async function recoveryCheck(baseline: Baseline, base: string, baselineBackup: string, snapshot: Raw, baselineUi: Record<string, unknown>): Promise<void> {
  await test.step(`the ${baseline.version} backup restores into a separate empty profile running the extracted beta ZIP`, async () => {
    const other = trackedSession(join(base, 'recovery-profile'), join(base, 'beta-extracted'));
    await other.launch();
    const page = await other.openDashboard({ accept: false });
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(VERSION);
    await expect(consentGate(page)).toBeVisible();
    await acceptViaUi(page);
    await expect(page.getByRole('button', { name: 'Restore from a JSON backup…' })).toHaveCount(0); // only after setup
    await setupViaUi(page, 'synthetic recovery passphrase 02');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    const fresh = (await decryptedRaw(page)) as Raw;
    await page.getByRole('button', { name: 'Restore from a JSON backup…' }).click();
    await chooseBackup(page, baselineBackup);
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const restored = (await decryptedRaw(page)) as Raw;
    expect(restored.cases).toEqual(snapshot.cases);
    expect(restored.revision).toBe(1);
    // The destination keeps its own marker; the source's never becomes this ledger's.
    expect(restored.ledgerEpoch).toBe(fresh.ledgerEpoch);
    expect(restored.ledgerEpoch).not.toBe(snapshot.ledgerEpoch);
    expect(restored.lastRestore).toMatchObject({ restoredRevision: 1, caseCount: snapshot.cases.length, sourceRevision: snapshot.revision });
    expect(restored.lastRestore!.operationId).not.toBe(snapshot.lastRestore!.operationId);
    // Restore neither imports nor implies agreement: the receipt is the one given here.
    expect(Object.keys(await storedRecords(page))).toEqual([VAULT_KEY]);
    expect(JSON.stringify(restored)).not.toContain('refund-reconciler-consent');
    await page.locator('#restore-cancel').click();
    expect(await uiState(page)).toEqual(baselineUi);
    await other.close();
  });
}

async function updateCheck(baseline: Baseline): Promise<void> {
  const base = join(work, baseline.version);
  const installed = join(base, 'installed-extension'); // the one stable folder Chrome loads, before and after the update
  const profile = join(base, 'profile');
  const downloads = join(base, 'downloads');
  await mkdir(downloads, { recursive: true });
  await cp(built.get(baseline.version)!, installed, { recursive: true });
  const session = trackedSession(profile, installed);

  // ---- 1. The baseline in a fresh profile ----
  let snapshot!: Raw;
  let baselineUi!: Record<string, unknown>;
  let baselineBackup = '';
  await test.step(`load ${baseline.version} and populate a rich synthetic plaintext ledger`, async () => {
    await session.launch();
    await ensureDeveloperMode(session);
    const page = await session.openDashboard();
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(baseline.version);
    if (baseline.version === '0.5.0') await expect(page.getByTestId('help')).toHaveCount(0); // the guide came in 0.6.0
    else await expect(page.getByTestId('help')).toHaveCount(1);
    await expect(vaultScreen(page, 'vault-setup')).toHaveCount(0); // no vault before 0.7.0
    expect(await legacyRaw(page)).toBeUndefined();

    await baselineEraseViaUi(page);
    const epoch = ((await legacyRaw(page)) as Raw).ledgerEpoch;
    expect(epoch).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    const rich = richLedger();
    await openRestore(page);
    await chooseBackup(page, await writeBackupFile(base, 'rich-synthetic.json', envelopeOf(rich)));
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await page.locator('#restore-cancel').click();

    await createCase(page, { orderRef: '113-0000000-0000507', items: [{ label: 'Synthetic kettle', amount: '60.00' }, { label: 'Synthetic mug', unknown: true }] });
    await expect(page.locator('#case-heading')).toContainText('113-0000000-0000507');
    await recordForItem(page, 'Synthetic kettle', 'Record merchant report', '60.00', { reference: 'RMA-UPD-1' });
    await recordForItem(page, 'Synthetic kettle', 'Confirm money received', '25.00', { reference: 'STMT-UPD-1', note: 'partial so far' });
    await recordForItem(page, 'Synthetic kettle', 'Record recharge', '10.00', { note: 'statement line' });
    const recharge = page.getByTestId('timeline-entry').filter({ hasText: 'You recorded a $10.00 recharge' });
    await recharge.getByRole('button', { name: /^Void/ }).click();
    await page.getByLabel('Why is this entry mistaken?').fill('Belongs to another order');
    await page.getByRole('button', { name: 'Void entry' }).click();
    await expect(recharge).toContainText('Voided');
    await expect(itemCard(page, 'Synthetic mug').getByTestId('item-expected')).toHaveText('Unknown');
    await page.getByRole('button', { name: '← All cases' }).click();

    snapshot = (await legacyRaw(page)) as Raw;
    const store = asStore(snapshot);
    expect(snapshot.ledgerEpoch).toBe(epoch);
    expect(snapshot.lastRestore).toMatchObject({ restoredRevision: 1, caseCount: rich.cases.length, sourceRevision: rich.revision });
    expect(snapshot.revision).toBeGreaterThan(1);
    expect(store.cases.slice(0, rich.cases.length)).toEqual(rich.cases);
    expect(store.cases.filter((c) => c.isDemo).length).toBe(2);
    const ui = store.cases.find((c) => c.orderRef === '113-0000000-0000507')!;
    expect(ui.entries.map((e) => e.kind)).toEqual(['expectation', 'expectation', 'merchant_report', 'receipt', 'recharge', 'void']);
    expect(ui.entries[1]).toMatchObject({ kind: 'expectation', amountCents: null });
    const captures = store.cases.flatMap((c) => c.entries).filter((e) => e.kind === 'merchant_report' && e.capture);
    expect(captures.map((e) => e.kind === 'merchant_report' && e.capture?.parserVersion).sort()).toEqual(['amazon-us-selection-1', 'amazon-us-selection-1', PARSER_VERSION].sort());

    // The baseline's own JSON export: a real backup of the earlier version, used for recovery below.
    const exported = await downloadBackup(page, downloads);
    expect(exported.envelope.store).toEqual(snapshot);
    baselineBackup = exported.path;
    baselineUi = await uiState(page);
    expect((baselineUi.rows as string[]).length).toBe(5);
    await page.close();
  });

  // ---- 2. Replace the files in the SAME folder with the extracted beta ZIP and reload ----
  const extensionId = session.extensionId;
  await replaceWithBetaZip(session, base, installed);

  // ---- 3. The updated installation: migration first, nothing changed until then ----
  await test.step('the current version shows its data practices first and changes nothing until Agree and continue', async () => {
    const page = await session.openDashboard({ accept: false });
    expect(await page.evaluate(() => chrome.runtime.id)).toBe(extensionId);
    await expectGatedAfterUpdate(session, page, { [LEGACY_KEY]: snapshot }, { kind: 'migrate', passphrase: PHRASE, acknowledged: true, replaceCandidate: false });
    await page.close();
  });

  await test.step('after agreement it asks to protect the existing records and changes nothing until then', async () => {
    const page = await session.openDashboard({ accept: false });
    await acceptViaUi(page);
    await expectReceipt(page);
    await expect(vaultScreen(page, 'vault-migrate')).toContainText(`saved ${snapshot.cases.length} cases in this browser without encryption`);
    await expect(page.getByRole('button', { name: 'Create case' })).toHaveCount(0);
    expect(await storedRecords(page)).toEqual({ [LEGACY_KEY]: snapshot });

    // The explicit pre-migration plaintext backup is complete and changes nothing.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download plaintext backup (JSON)' }).click()]);
    const path = join(downloads, `pre-migration-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    const pre = JSON.parse(await readFile(path, 'utf8'));
    expect(pre).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(pre.store).toEqual(snapshot);
    expect(await storedRecords(page)).toEqual({ [LEGACY_KEY]: snapshot });

    // Historical captures stay as stored; the current parser would refuse one of them.
    expect(analyzeExcerpt(HISTORICAL_REFUSED_EXCERPT).issued).toBeNull();

    await recordWorkerStorage(workerOf(session));
    await migrateViaUi(page, PHRASE);
    const ops = await workerOf(session).evaluate(() => (globalThis as unknown as { __ops: string[] }).__ops);
    const migration = ops.slice(ops.findIndex((o) => o === 'set(migration)'));
    // Marker, candidate, read-back for verification, verified marker, then and only then removal of the plaintext.
    expect(migration.slice(0, 6)).toEqual(['set(migration)', 'set(vault)', 'get(store,vault,migration)', 'set(migration)', 'remove(store)', 'remove(migration)']);
    expect(Object.keys(await storedRecords(page))).toEqual([VAULT_KEY]);
    // Exactly the same ledger, field for field: ids, timestamps, notes, voids, demo flags, captures, revision, receipt and marker.
    expect(await decryptedRaw(page)).toEqual(snapshot);
    expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toMatch(/Synthetic kettle|STMT-UPD-1|partial so far/);
    const hist = asStore(await decryptedRaw(page)).cases.flatMap((c) => c.entries).find((e) => e.id === 'cap-hist');
    expect(hist).toMatchObject({ amountCents: 3500, capture: { parserVersion: 'amazon-us-selection-1', excerpt: HISTORICAL_REFUSED_EXCERPT } });

    // Same calculated states as the baseline showed, from the current UI and domain code.
    expect(await uiState(page)).toEqual(baselineUi);
    const store = asStore(snapshot);
    expect(asStore(await decryptedRaw(page)).cases.map(summarizeCase)).toEqual(store.cases.map(summarizeCase));
    expect(buildOverview(realCaseViews(asStore(await decryptedRaw(page)).cases))).toEqual(buildOverview(realCaseViews(store.cases)));
    // Opening the guide writes nothing.
    await page.getByText('How to use Refund Reconciler').click();
    for (const s of await page.getByTestId('help').locator('details > summary').all()) await s.click();
    await page.getByText('How to use Refund Reconciler').click();
    expect(await decryptedRaw(page)).toEqual(snapshot);
    await page.close();
  });

  await test.step('after a full browser restart: same installation, locked until the passphrase, same data; new writes are encrypted', async () => {
    await session.close();
    await session.launch();
    expect(session.extensionId).toBe(extensionId);
    await ensureDeveloperMode(session); // still on after the restart
    const page = await session.openDashboard({ accept: false });
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(VERSION);
    // The agreement survives the restart; the vault is locked again.
    await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
    await expect(consentGate(page)).toHaveCount(0);
    await expect(page.getByTestId('case-row')).toHaveCount(0);
    await unlockViaUi(page, PHRASE);
    expect(await decryptedRaw(page)).toEqual(snapshot);
    expect(await uiState(page)).toEqual(baselineUi);

    // The current version's own backup is the same plaintext format-1 ledger.
    const { envelope } = await downloadBackup(page, downloads);
    expect(envelope).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(envelope.store).toEqual(snapshot);

    // Restoring into this populated installation is refused and changes nothing.
    await openRestore(page);
    await chooseBackup(page, baselineBackup);
    await expect(destination(page)).toHaveAttribute('data-state', 'not_empty');
    await expect(approveButton(page)).toBeDisabled();
    await page.locator('#restore-cancel').click();
    expect(await decryptedRaw(page)).toEqual(snapshot);

    // A new write continues the same history, encrypted.
    await page.getByTestId('case-row').filter({ hasText: '113-0000000-0000507' }).click();
    await recordForItem(page, 'Synthetic kettle', 'Confirm money received', '5.00', { note: 'after the update' });
    const after = asStore(await decryptedRaw(page));
    expect(after.revision).toBe(snapshot.revision + 1);
    expect(after.ledgerEpoch).toBe(snapshot.ledgerEpoch);
    expect(after.lastRestore).toEqual(snapshot.lastRestore);
    expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toMatch(/Synthetic mug|after the update/);
    await session.close();
  });

  // ---- 4. Recovery: the baseline's own backup restores into a separate, empty, encrypted installation ----
  await recoveryCheck(baseline, base, baselineBackup, snapshot, baselineUi);
}

/**
 * 0.7.0 → current: the encrypted vault, its passphrase, erase marker and
 * restore receipt are kept exactly. Nothing is reset or converted to
 * plaintext; the agreement is required first, then the existing passphrase
 * unlocks the same vault.
 */
async function updateCheck070(): Promise<void> {
  const baseline = BASELINE_070;
  const base = join(work, baseline.version);
  const installed = join(base, 'installed-extension');
  const profile = join(base, 'profile');
  const downloads = join(base, 'downloads');
  await mkdir(downloads, { recursive: true });
  await cp(built.get(baseline.version)!, installed, { recursive: true });
  const session = trackedSession(profile, installed);

  // ---- 1. 0.7.0 in a fresh profile, with its own passphrase ----
  let snapshot!: Raw;
  let baselineUi!: Record<string, unknown>;
  let baselineBackup = '';
  let storedBefore!: Record<string, unknown>;
  await test.step('load 0.7.0, protect it with a passphrase and populate a rich synthetic encrypted ledger', async () => {
    await session.launch();
    await ensureDeveloperMode(session);
    const page = await session.openDashboard({ unlock: false });
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe('0.7.0');
    await expect(consentGate(page)).toHaveCount(0); // no data-practices step before 0.8.0
    await expect(page.getByTestId('privacy')).toHaveCount(0);
    await setupViaUi(page, PHRASE);

    // 0.7.0's own typed erase from its locked screen, so the ledger carries an erase marker.
    await page.getByRole('button', { name: 'Lock now' }).click();
    await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
    await page.getByText('Forgot your passphrase?').click();
    await page.getByRole('button', { name: 'Erase stored data…' }).click();
    await page.getByLabel('Type ERASE to confirm').fill('ERASE');
    await page.getByRole('button', { name: 'Permanently erase' }).click();
    await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
    const epoch = ((await page.evaluate(() => chrome.storage.local.get('refundReconciler.erased')))['refundReconciler.erased'] as { epoch: string }).epoch;
    await setupViaUi(page, PHRASE);

    const rich = richLedger();
    await openRestore(page);
    await chooseBackup(page, await writeBackupFile(base, 'rich-synthetic.json', envelopeOf(rich)));
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await page.locator('#restore-cancel').click();

    await createCase(page, { orderRef: '113-0000000-0000707', items: [{ label: 'Synthetic toaster', amount: '45.00' }, { label: 'Synthetic tray', unknown: true }] });
    await recordForItem(page, 'Synthetic toaster', 'Record merchant report', '45.00', { reference: 'RMA-UPD-7' });
    await recordForItem(page, 'Synthetic toaster', 'Confirm money received', '20.00', { reference: 'STMT-UPD-7', note: 'partial 0.7.0' });
    await page.getByRole('button', { name: '← All cases' }).click();

    snapshot = (await decryptedRaw(page)) as Raw;
    const store = asStore(snapshot);
    expect(snapshot.ledgerEpoch).toBe(epoch);
    expect(snapshot.lastRestore).toMatchObject({ restoredRevision: 1, caseCount: rich.cases.length, sourceRevision: rich.revision });
    expect(store.cases.slice(0, rich.cases.length)).toEqual(rich.cases);
    storedBefore = await page.evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(storedBefore).sort()).toEqual(['refundReconciler.erased', VAULT_KEY]);
    expect(JSON.stringify(storedBefore)).not.toMatch(/Synthetic toaster|STMT-UPD-7|partial 0\.7\.0/);

    const exported = await downloadBackup(page, downloads);
    expect(exported.envelope.store).toEqual(snapshot);
    baselineBackup = exported.path;
    baselineUi = await uiState(page);
    expect((baselineUi.rows as string[]).length).toBe(5);
    await page.close();
  });

  // ---- 2. Same folder, extracted beta ZIP, reload ----
  const extensionId = session.extensionId;
  await replaceWithBetaZip(session, base, installed);

  // ---- 3. Gated, then the existing vault with the existing passphrase ----
  await test.step('the current version shows its data practices first and changes nothing until Agree and continue', async () => {
    const page = await session.openDashboard({ accept: false });
    expect(await page.evaluate(() => chrome.runtime.id)).toBe(extensionId);
    await expectGatedAfterUpdate(session, page, storedBefore, { kind: 'unlock', passphrase: PHRASE });
    await page.close();
  });

  await test.step('after agreement the same vault is locked and opens with the 0.7.0 passphrase, unchanged and still encrypted', async () => {
    const page = await session.openDashboard({ accept: false });
    await acceptViaUi(page);
    await expectReceipt(page);
    await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
    await expect(vaultScreen(page, 'vault-setup')).toHaveCount(0);
    await unlockViaUi(page, PHRASE);
    // The very same ciphertext, marker and no plaintext key: no reset, re-encryption or conversion.
    expect(await storedRecords(page)).toEqual(storedBefore);
    expect(await decryptedRaw(page)).toEqual(snapshot);
    expect(await uiState(page)).toEqual(baselineUi);
    await page.close();
  });

  await test.step('after a full browser restart: agreement kept, locked until the passphrase, same data; export, restore and new writes behave', async () => {
    await session.close();
    await session.launch();
    expect(session.extensionId).toBe(extensionId);
    await ensureDeveloperMode(session);
    const page = await session.openDashboard({ accept: false });
    await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
    await expect(consentGate(page)).toHaveCount(0);
    await unlockViaUi(page, PHRASE);
    expect(await decryptedRaw(page)).toEqual(snapshot);

    const { envelope } = await downloadBackup(page, downloads);
    expect(envelope).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(envelope.store).toEqual(snapshot);
    expect(JSON.stringify(envelope)).not.toContain('refund-reconciler-consent');

    await openRestore(page);
    await chooseBackup(page, baselineBackup);
    await expect(destination(page)).toHaveAttribute('data-state', 'not_empty');
    await expect(approveButton(page)).toBeDisabled();
    await page.locator('#restore-cancel').click();
    expect(await decryptedRaw(page)).toEqual(snapshot);

    await page.getByTestId('case-row').filter({ hasText: '113-0000000-0000707' }).click();
    await recordForItem(page, 'Synthetic toaster', 'Confirm money received', '5.00', { note: 'after the update' });
    const after = asStore(await decryptedRaw(page));
    expect(after.revision).toBe(snapshot.revision + 1);
    expect(after.ledgerEpoch).toBe(snapshot.ledgerEpoch);
    expect(after.lastRestore).toEqual(snapshot.lastRestore);
    expect(Object.keys(await storedRecords(page)).sort()).toEqual(['refundReconciler.erased', VAULT_KEY]);
    expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toMatch(/Synthetic tray|after the update/);
    await session.close();
  });

  await recoveryCheck(baseline, base, baselineBackup, snapshot, baselineUi);
}

test('0.5.0 updated in place keeps the same installation, requires agreement first, migrates every record into the vault, and its backup restores elsewhere', async () => {
  test.setTimeout(300_000);
  await updateCheck(BASELINE_050);
});

test('0.6.0 updated in place keeps the same installation, requires agreement first, migrates every record into the vault, and its backup restores elsewhere', async () => {
  test.setTimeout(300_000);
  await updateCheck(BASELINE_060);
});

test('0.7.0 updated in place keeps the same installation and its encrypted vault and passphrase, requires agreement first, and its backup restores elsewhere', async () => {
  test.setTimeout(300_000);
  await updateCheck070();
});
