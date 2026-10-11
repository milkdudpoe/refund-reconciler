// Chrome Web Store listing images, produced from the production beta package.
// Run through `npm run assets:store` (scripts/store-assets.ts), which packages
// the beta first and validates and reports on what this writes.
//
// - The small promotional tile is rendered from its editable SVG at exactly
//   440x280 (no scaling after rasterisation).
// - The three screenshots come from the extracted beta ZIP in artifacts/beta/
//   (checked against its .sha256), never dist/ or a test copy with extra
//   permissions, loaded into a new disposable profile that is deleted
//   afterwards. Everything is done through the real UI: the data-practices
//   screen, Protect your records with a random throwaway passphrase that is
//   never written anywhere, then ordinary forms to create made-up cases and
//   evidence. Nothing is injected into storage, the DOM or the CSS, and no
//   product text or warning is hidden. Each pictured state is asserted in the
//   UI, and the totals and evidence are cross-checked against the worker's own
//   read of the ledger, before the capture.
//
// Device scale factor: the 1280x800 PNGs are captured from a 960x600 CSS-px
// viewport at deviceScaleFactor 4/3, as on a high-density display, so the text
// stays legible when the store shows them at 640x400. Layout and styles are
// the product's own responsive layout at that width.
//
// Not shown or claimed: the toolbar popup or a real toolbar grant, capture of
// a refund line (no validated real Amazon refund line exists), or anything
// about real orders. All data is synthetic and labelled "Synthetic".

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, test, type Locator, type Page } from '@playwright/test';
import { buildOverview, realCaseViews } from '../../src/domain/overview';
import { summarizeCase } from '../../src/domain/reconcile';
import type { CaseRecord, StoreData } from '../../src/domain/types';
import { ExtensionSession, createCase, expect, itemCard } from '../e2e/fixtures';
import { acceptViaUi, consentGate, setupViaUi } from '../e2e/vault-helpers';
import { extractBetaZip } from '../package/extract';
import { STORE_FILES } from '../../scripts/store/checks.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const BETA = join(ROOT, 'artifacts', 'beta', `refund-reconciler-beta-${VERSION}`);
const OUT = join(ROOT, 'artifacts', 'store-assets');

const FILES = {
  tile: STORE_FILES.tile,
  overview: STORE_FILES.screenshots[0],
  evidence: STORE_FILES.screenshots[1],
  summary: STORE_FILES.screenshots[2],
  capture: STORE_FILES.capture,
};

const VIEWPORT = { width: 960, height: 600 };
const DEVICE_SCALE = 4 / 3;

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function writeOutput(name: string, data: Uint8Array | string): Promise<void> {
  const path = resolve(OUT, name);
  if (!path.startsWith(OUT + sep)) throw new Error(`refusing output outside artifacts/store-assets: ${name}`);
  await writeFile(path, data);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
  for (const name of Object.values(FILES)) await rm(join(OUT, name), { force: true });
});

test('small promotional tile: the editable SVG rendered at exactly 440x280', async () => {
  const svg = await readFile(join(ROOT, 'store-assets', 'source', 'small-promo-tile.svg'));
  expect(svg.toString('utf8')).not.toMatch(/<text\b|<image\b|href="http/);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0}img{display:block}</style><img width="440" height="280" src="data:image/svg+xml;base64,${svg.toString('base64')}">`,
    );
    await page.locator('img').evaluate((img: HTMLImageElement) => img.decode());
    await writeOutput(FILES.tile, await page.screenshot({ clip: { x: 0, y: 0, width: 440, height: 280 } }));
  } finally {
    await browser.close();
  }
});

/** One synthetic evidence entry, typed into the real entry form. */
async function record(
  page: Page,
  label: string,
  action: 'Record merchant report' | 'Confirm money received',
  amount: string,
  opts: { date?: string; reference?: string } = {},
): Promise<void> {
  await itemCard(page, label).getByRole('button', { name: action }).click();
  const form = page.getByTestId('entry-form');
  await form.getByRole('textbox', { name: /USD/ }).fill(amount);
  if (opts.date) await form.getByLabel(/^Date/).fill(opts.date);
  if (opts.reference) await form.getByLabel(/reference/).fill(opts.reference);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId('notice')).toHaveText('Entry saved.');
}

async function backToList(page: Page): Promise<void> {
  await page.getByRole('button', { name: '← All cases' }).click();
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible();
}

/** Scrolls the page normally so `target` starts at the top of the viewport. */
async function scrollToTop(target: Locator, offset = 8): Promise<void> {
  await target.evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off, behavior: 'instant' }), offset);
}

async function capture(page: Page, name: string): Promise<{ file: string; bytes: number; sha256: string }> {
  // Nothing transient or secret in view: no notice banner, no open form, no passphrase field.
  await expect(page.getByTestId('notice')).toHaveCount(0);
  await expect(page.getByTestId('entry-form')).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await writeOutput(name, png);
  return { file: name, bytes: png.length, sha256: sha256(png) };
}

/** Reads the ledger through the worker's own read command (the same one the dashboard uses). */
async function workerStore(page: Page): Promise<StoreData> {
  const res = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'read' }))) as { ok: boolean; ledger: { status: string; store?: StoreData } };
  expect(res.ok).toBe(true);
  expect(res.ledger.status).toBe('ok');
  return res.ledger.store!;
}

test('three screenshots from the extracted production beta ZIP with synthetic data', async () => {
  const zip = await readFile(`${BETA}.zip`).catch(() => {
    throw new Error(`${BETA}.zip is missing; run \`npm run package:beta\` (or \`npm run assets:store\`) first.`);
  });
  const digest = sha256(zip);
  expect(await readFile(`${BETA}.zip.sha256`, 'utf8')).toBe(`${digest}  refund-reconciler-beta-${VERSION}.zip\n`);
  const betaReport = JSON.parse(await readFile(`${BETA}.report.json`, 'utf8')) as { sha256: string; sourceCommit: string | null };
  expect(betaReport.sha256).toBe(digest);

  // A disposable directory created here; only it is removed afterwards.
  const work = await mkdtemp(join(tmpdir(), 'refund-reconciler-store-assets-'));
  const passphrase = `throwaway ${randomBytes(12).toString('hex')}`;
  try {
    const extracted = join(work, 'extension');
    await extractBetaZip(zip, extracted);
    const session = new ExtensionSession(join(work, 'profile'), extracted, {
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    await session.launch();
    try {
      const page = await session.openDashboard({ accept: false });
      const manifest = await page.evaluate(() => chrome.runtime.getManifest());
      expect(manifest).toMatchObject({ version: VERSION, name: 'Refund Reconciler (local preview)', permissions: ['storage', 'activeTab', 'scripting'] });
      expect(manifest.host_permissions ?? []).toEqual([]);
      const browserVersion = session.context!.browser()?.version() ?? (await page.evaluate(() => navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown'));

      // The real first-run flow: data practices, Agree and continue, then Protect your records.
      await expect(consentGate(page)).toBeVisible();
      await acceptViaUi(page);
      await setupViaUi(page, passphrase);

      // Case A: partially confirmed (merchant report $64.00, confirmed $40.00 of $64.00 expected).
      await createCase(page, { orderRef: 'SYNTHETIC-1001', items: [{ label: 'Synthetic wool blanket', amount: '64.00' }] });
      await expect(page.locator('#case-heading')).toContainText('SYNTHETIC-1001');
      await record(page, 'Synthetic wool blanket', 'Record merchant report', '64.00', { date: '2026-09-21', reference: 'SYNTHETIC-OBS-1' });
      await record(page, 'Synthetic wool blanket', 'Confirm money received', '40.00', { date: '2026-09-24', reference: 'SYNTHETIC-STMT-1' });
      await backToList(page);

      // Case B: needs review (confirmed $35.00 in full, but the latest merchant report says $30.00).
      await createCase(page, { orderRef: 'SYNTHETIC-1002', items: [{ label: 'Synthetic desk lamp', amount: '35.00' }] });
      await record(page, 'Synthetic desk lamp', 'Confirm money received', '35.00', { date: '2026-09-18' });
      await record(page, 'Synthetic desk lamp', 'Record merchant report', '30.00', { date: '2026-09-19' });
      await backToList(page);

      // Case C: open (merchant reports $18.50 but nothing confirmed) plus an item with an unknown expected amount.
      await createCase(page, {
        orderRef: 'SYNTHETIC-1003',
        items: [{ label: 'Synthetic phone case', amount: '18.50' }, { label: 'Synthetic cable bundle', unknown: true }],
      });
      await record(page, 'Synthetic phone case', 'Record merchant report', '18.50', { date: '2026-09-27' });
      await backToList(page);

      // Case D: settled, for contrast.
      await createCase(page, { orderRef: 'SYNTHETIC-1004', items: [{ label: 'Synthetic headphones', amount: '89.99' }] });
      await record(page, 'Synthetic headphones', 'Confirm money received', '89.99', { date: '2026-09-15' });
      await backToList(page);

      // Cross-check against the worker's own read: four real (non-demo) cases and the expected derived states.
      const store = await workerStore(page);
      const byRef = (ref: string) => store.cases.find((c: CaseRecord) => c.orderRef === ref)!;
      expect(store.cases.map((c: CaseRecord) => [c.orderRef, c.isDemo]).sort()).toEqual([
        ['SYNTHETIC-1001', false],
        ['SYNTHETIC-1002', false],
        ['SYNTHETIC-1003', false],
        ['SYNTHETIC-1004', false],
      ]);
      const overview = buildOverview(realCaseViews(store.cases));
      expect(overview).toMatchObject({ caseCount: 4, unresolved: { ok: true, cents: 4250 }, unknownItemCount: 1, attentionCount: 3, reviewCount: 1 });
      const a = summarizeCase(byRef('SYNTHETIC-1001'));
      expect(a.items[0]).toMatchObject({ expectedCents: 6400, merchantReportedCents: 6400, confirmedReceivedCents: 4000, unresolvedCents: 2400, status: 'partial' });
      expect(summarizeCase(byRef('SYNTHETIC-1002')).items[0]!.reviewReasons.length).toBeGreaterThan(0);
      expect(summarizeCase(byRef('SYNTHETIC-1004')).status).toBe('settled');

      // Clean final state: reload the dashboard (still unlocked in this browser session) so no
      // "Entry saved." notice remains, as when a user comes back to it.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible();

      // ---- Screenshot 1: overview and case list ----
      const overviewPanel = page.getByTestId('overview');
      await expect(overviewPanel.getByRole('heading')).toHaveText('Overview of all 4 cases you saved');
      await expect(page.getByTestId('overview-unresolved')).toHaveText('$42.50');
      await expect(page.getByTestId('overview-unknown')).toHaveText('1');
      await expect(page.getByTestId('overview-attention')).toHaveText('3');
      await expect(page.getByTestId('overview-review')).toHaveText('1');
      await expect(page.getByTestId('results-count')).toHaveText('Showing all 4 cases');
      await expect(page.getByTestId('demo-cases')).toHaveCount(0);
      await scrollToTop(page.getByRole('heading', { name: 'Your cases' }), 24);
      await expect(page.getByTestId('overview-unresolved')).toBeInViewport();
      await expect(page.getByLabel('Search by order reference or item description')).toBeInViewport();
      await expect(page.getByLabel('Status')).toBeInViewport();
      const rows = page.getByTestId('case-row');
      await expect(rows).toHaveCount(4);
      const shot1 = await capture(page, FILES.overview);

      // ---- Screenshot 2: one item's refund evidence ----
      await rows.filter({ hasText: 'SYNTHETIC-1001' }).click();
      await expect(page.locator('#case-heading')).toContainText('SYNTHETIC-1001');
      const blanket = itemCard(page, 'Synthetic wool blanket');
      await expect(blanket.getByTestId('item-status')).toHaveText('Partially confirmed');
      await expect(blanket.getByTestId('item-expected')).toHaveText('$64.00');
      await expect(blanket.getByTestId('item-reported')).toHaveText('$64.00');
      await expect(blanket.getByTestId('item-difference')).toHaveText('$24.00');
      await expect(blanket).toContainText('Merchant reports more issued than you have confirmed received.');
      const timeline = page.getByTestId('timeline-entry');
      await expect(timeline.filter({ hasText: 'Merchant reported $64.00 issued' })).toHaveCount(1);
      await expect(timeline.filter({ hasText: 'You confirmed $40.00 received' })).toHaveCount(1);
      await scrollToTop(page.locator('#case-heading'), 24);
      await expect(blanket.getByTestId('item-status')).toBeInViewport();
      await expect(blanket.getByTestId('item-difference')).toBeInViewport();
      const shot2 = await capture(page, FILES.evidence);

      // ---- Screenshot 3: Prepare case summary, evidence details omitted ----
      await page.getByRole('button', { name: 'Prepare case summary…' }).click();
      const panel = page.getByTestId('export-panel');
      await expect(panel.getByRole('heading', { name: 'Case summary preview' })).toBeVisible();
      await expect(page.locator('#export-details')).not.toBeChecked();
      const text = page.getByTestId('export-text');
      await expect(text).toHaveValue(/Order reference: SYNTHETIC-1001/);
      await expect(text).toHaveValue(/Evidence details: omitted/);
      await expect(text).not.toHaveValue(/SYNTHETIC-STMT-1|SYNTHETIC-OBS-1/);
      await expect(panel).toContainText('You send or share it yourself; the extension does not contact Amazon or send anything.');
      await expect(panel).toContainText('Off by default, because these may contain private text.');
      await scrollToTop(panel, 6);
      await expect(panel.getByRole('heading', { name: 'Case summary preview' })).toBeInViewport();
      await expect(page.locator('#export-details')).toBeInViewport();
      await expect(panel.getByText('Off by default, because these may contain private text.', { exact: false })).toBeInViewport();
      await expect(text).toBeInViewport({ ratio: 0.6 });
      const shot3 = await capture(page, FILES.summary);

      await writeOutput(
        FILES.capture,
        `${JSON.stringify(
          {
            package: { file: `refund-reconciler-beta-${VERSION}.zip`, sha256: digest, sourceCommit: betaReport.sourceCommit },
            extension: { name: manifest.name, version: manifest.version, permissions: manifest.permissions },
            browser: { name: 'Chromium (Playwright bundled)', version: browserVersion },
            capture: { viewportCssPx: VIEWPORT, deviceScaleFactor: DEVICE_SCALE, locale: 'en-US', timezoneId: 'America/New_York' },
            verified: {
              realCases: overview.caseCount,
              demoCases: 0,
              unresolvedCents: 4250,
              unknownItems: overview.unknownItemCount,
              casesNeedingAttention: overview.attentionCount,
              casesNeedingReview: overview.reviewCount,
            },
            screenshots: [
              { ...shot1, scenario: 'Overview and case list: four synthetic manual cases (SYNTHETIC-1001 partially confirmed, SYNTHETIC-1002 needs review, SYNTHETIC-1003 open with one unknown expected amount, SYNTHETIC-1004 settled); no demo cases. Overview $42.50 unresolved, 1 unknown amount, 3 need attention, 1 needs review; search and Status controls visible.' },
              { ...shot2, scenario: 'Case SYNTHETIC-1001, item "Synthetic wool blanket": expected $64.00, merchant report $64.00 (2026-09-21), confirmed received $40.00 (2026-09-24); Partially confirmed, $24.00 difference, merchant-reported vs confirmed warning.' },
              { ...shot3, scenario: 'Prepare case summary for SYNTHETIC-1001: the read-only plain-text preview with "Include evidence details" unticked (the synthetic references are omitted), the note that details may contain private text, and that the user shares the text themselves; nothing is sent.' },
            ],
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await session.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
