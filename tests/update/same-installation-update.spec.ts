// Same-installation update check: the previous production version (0.5.0,
// built from its own source at BASELINE_COMMIT) is loaded from one stable
// temporary folder, given a rich synthetic ledger, and then updated in place
// to the current beta by replacing that folder's files with the contents of
// the real beta ZIP and reloading the extension. Run with `npm run test:update`.
//
// Only temporary folders and profiles created here are used, and all data is
// synthetic. Nothing is added to the production package: the beta ZIP is
// extracted unchanged, and the baseline is built with its own production build.
//
// Data setup (disclosed): the rich ledger is constructed by test code
// (tests/shared/rich-ledger.ts) and written to a backup file, then loaded into
// 0.5.0 through 0.5.0's own "Restore from JSON…" UI. Before that, a corrupt
// value is written directly to storage only to reach 0.5.0's "Erase stored
// data…" control, so the ledger carries an erase marker (ledgerEpoch) as well
// as a restore receipt. One further case is then created entirely through
// 0.5.0's UI.
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
import { seed, storedRaw } from '../e2e/export-helpers';
import { approveButton, chooseBackup, destination, envelopeOf, eraseViaUi, expectEligible, openRestore, saveBackupDownload, writeBackupFile } from '../e2e/restore-helpers';
import { HISTORICAL_REFUSED_EXCERPT, richLedger } from '../shared/rich-ledger';
import { BASELINE_VERSION, buildBaseline, exportBaselineSource } from './baseline';

const ROOT = resolve(import.meta.dirname, '../..');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const ZIP = join(ROOT, 'artifacts', 'beta', `refund-reconciler-beta-${VERSION}.zip`);
const CORRUPT = { schemaVersion: 1, revision: 1, cases: [{ id: 'c', amountCents: 1.5 }] };

type Raw = StoreData & Record<string, unknown>;

let work = '';
let baselineDist = '';
/** Every browser session this file starts; all are closed before the work folder is removed. */
const sessions = new Set<ExtensionSession>();

test.beforeAll(async () => {
  test.setTimeout(300_000);
  work = await mkdtemp(join(tmpdir(), 'refund-reconciler-update-'));
  baselineDist = await buildBaseline(await exportBaselineSource(work));
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

test('0.5.0 updated in place to the beta keeps the same installation and every record, and its backup restores elsewhere', async () => {
  test.setTimeout(240_000);
  const installed = join(work, 'installed-extension'); // the one stable folder Chrome loads, before and after the update
  const profile = join(work, 'profile');
  const downloads = join(work, 'downloads');
  await mkdir(downloads);
  await cp(baselineDist, installed, { recursive: true });
  const session = trackedSession(profile, installed);

  // ---- 1. Baseline 0.5.0 in a fresh profile ----
  let snapshot!: Raw;
  let baselineUi!: Record<string, unknown>;
  await test.step('load 0.5.0 and populate a rich synthetic ledger', async () => {
    await session.launch();
    await ensureDeveloperMode(session);
    const page = await session.openDashboard();
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(BASELINE_VERSION);
    await expect(page.getByTestId('help')).toHaveCount(0); // the beta's guide does not exist yet
    expect(await storedRaw(page)).toBeUndefined();

    // Erase marker through 0.5.0's own UI (reached via a deliberately corrupt value).
    await eraseViaUi(page, (p) => seed(p, CORRUPT));
    const epoch = ((await storedRaw(page)) as Raw).ledgerEpoch;
    expect(epoch).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    // Rich ledger through 0.5.0's own restore UI.
    const rich = richLedger();
    await openRestore(page);
    await chooseBackup(page, await writeBackupFile(work, 'rich-synthetic.json', envelopeOf(rich)));
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await page.locator('#restore-cancel').click();

    // One more case entirely through 0.5.0's UI: partial receipt, merchant report, recharge and its void, unknown item.
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

    // Read back and validate what 0.5.0 stored.
    snapshot = (await storedRaw(page)) as Raw;
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

    // 0.5.0's own JSON export contains exactly what it stored.
    const exported = await downloadBackup(page, downloads);
    expect(exported.envelope.store).toEqual(snapshot);
    baselineUi = await uiState(page);
    expect((baselineUi.rows as string[]).length).toBe(5);
    await page.close();
  });

  // ---- 2. Replace the files in the SAME folder with the extracted beta ZIP and reload ----
  const extensionId = session.extensionId;
  await test.step('replace the installed folder with the extracted beta ZIP and reload the extension', async () => {
    const zip = await readFile(ZIP).catch(() => {
      throw new Error(`${ZIP} is missing; run \`npm run package:beta\` first.`);
    });
    const extracted = join(work, 'beta-extracted');
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

  // ---- 3. Inspect the updated installation ----
  await test.step('the beta reads the same ledger unchanged and calculates the same case states', async () => {
    const page = await session.openDashboard();
    const loaded = await page.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() }));
    expect(loaded.id).toBe(extensionId);
    expect(loaded.manifest.version).toBe(VERSION);
    expect(loaded.manifest.host_permissions ?? []).toEqual([]);
    expect(await storedRaw(page)).toEqual(snapshot);

    // Historical captures stay as stored; the current parser would refuse one of them.
    expect(analyzeExcerpt(HISTORICAL_REFUSED_EXCERPT).issued).toBeNull();
    const hist = asStore(await storedRaw(page)).cases.flatMap((c) => c.entries).find((e) => e.id === 'cap-hist');
    expect(hist).toMatchObject({ amountCents: 3500, capture: { parserVersion: 'amazon-us-selection-1', excerpt: HISTORICAL_REFUSED_EXCERPT } });

    // Opening the new guide (and its sections) writes nothing.
    await page.getByText('How to use Refund Reconciler').click();
    await expect(page.getByTestId('help')).toHaveAttribute('open');
    for (const s of await page.getByTestId('help').locator('details > summary').all()) await s.click();
    await page.getByText('How to use Refund Reconciler').click();
    expect(await storedRaw(page)).toEqual(snapshot);

    // Same calculated states as 0.5.0 showed, from the beta's own UI and domain code.
    expect(await uiState(page)).toEqual(baselineUi);
    const store = asStore(snapshot);
    expect(asStore(await storedRaw(page)).cases.map(summarizeCase)).toEqual(store.cases.map(summarizeCase));
    expect(buildOverview(realCaseViews(asStore(await storedRaw(page)).cases))).toEqual(buildOverview(realCaseViews(store.cases)));
    expect(await storedRaw(page)).toEqual(snapshot);
    await page.close();
  });

  let backupPath = '';
  await test.step('the beta’s Download JSON contains every record', async () => {
    const page = await session.openDashboard();
    const { path, envelope } = await downloadBackup(page, downloads);
    backupPath = path;
    expect(envelope).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
    expect(envelope.store).toEqual(snapshot);
    expect(await storedRaw(page)).toEqual(snapshot);
    await page.close();
  });

  await test.step('after a full browser restart: same installation, same version, same data', async () => {
    await session.close();
    await session.launch();
    expect(session.extensionId).toBe(extensionId);
    await ensureDeveloperMode(session); // still on after the restart
    const page = await session.openDashboard();
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(VERSION);
    expect(await storedRaw(page)).toEqual(snapshot);
    expect(await uiState(page)).toEqual(baselineUi);

    // Restoring the backup into this populated installation is refused and changes nothing.
    await openRestore(page);
    await chooseBackup(page, backupPath);
    await expect(destination(page)).toHaveAttribute('data-state', 'not_empty');
    await expect(approveButton(page)).toBeDisabled();
    await page.locator('#restore-cancel').click();
    expect(await storedRaw(page)).toEqual(snapshot);
    await session.close();
  });

  // ---- 4. Recovery: the beta's backup restores into a separate, empty profile ----
  await test.step('the backup restores into a separate empty profile running the extracted beta ZIP', async () => {
    const other = trackedSession(join(work, 'recovery-profile'), join(work, 'beta-extracted'));
    await other.launch();
    const page = await other.openDashboard();
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(VERSION);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await page.getByRole('button', { name: 'Restore from a JSON backup…' }).click();
    await chooseBackup(page, backupPath);
    await expectEligible(page);
    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const restored = (await storedRaw(page)) as Raw;
    expect(restored.cases).toEqual(snapshot.cases);
    expect(restored.revision).toBe(1);
    expect(restored.ledgerEpoch).toBeUndefined(); // the source's marker never becomes this ledger's
    expect(restored.lastRestore).toMatchObject({ restoredRevision: 1, caseCount: snapshot.cases.length, sourceRevision: snapshot.revision });
    expect(restored.lastRestore!.operationId).not.toBe(snapshot.lastRestore!.operationId);
    await page.locator('#restore-cancel').click();
    expect(await uiState(page)).toEqual(baselineUi);
    await other.close();
  });
});
