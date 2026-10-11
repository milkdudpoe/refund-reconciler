// Smoke test of the installable beta archive itself. It extracts the ZIP that
// `npm run package:beta` wrote to artifacts/beta/ into a fresh temporary
// directory, loads THAT extracted extension (never dist/) into Playwright's
// Chromium with a new, empty synthetic profile, and runs the local workflow a
// tester would try first. All data is synthetic.
//
// What this does not show: that a real toolbar click grants page access, or
// that capture works on current Amazon pages. See docs/beta.md.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base } from '@playwright/test';
import { ExtensionSession, createCase, expect, recordForItem } from '../e2e/fixtures';
import { CONSENT_KEY, VAULT_KEY, acceptViaUi, consentGate, decryptedRaw, setupViaUi, unlockViaUi, vaultScreen } from '../e2e/vault-helpers';
import { extractBetaZip } from './extract';

const ROOT = resolve(import.meta.dirname, '../..');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const BASE = `refund-reconciler-beta-${VERSION}`;
const ZIP = join(ROOT, 'artifacts', 'beta', `${BASE}.zip`);

const test = base.extend<{ packaged: { session: ExtensionSession; extracted: string; zip: Buffer } }>({
  // eslint-disable-next-line no-empty-pattern
  packaged: async ({}, use) => {
    const zip = await readFile(ZIP).catch(() => {
      throw new Error(`${ZIP} is missing; run \`npm run package:beta\` first.`);
    });
    const work = await mkdtemp(join(tmpdir(), 'refund-reconciler-beta-smoke-'));
    const extracted = join(work, 'extension');
    await extractBetaZip(zip, extracted);
    const session = new ExtensionSession(join(work, 'profile'), extracted);
    await session.launch();
    await use({ session, extracted, zip });
    await session.close();
    await rm(work, { recursive: true, force: true });
  },
});

test('the extracted beta ZIP loads with production settings and its local workflow works end to end', async ({ packaged }) => {
  const { session, extracted, zip } = packaged;

  // The checksum written next to the archive matches it.
  const sum = await readFile(join(ROOT, 'artifacts', 'beta', `${BASE}.zip.sha256`), 'utf8');
  expect(sum).toBe(`${createHash('sha256').update(zip).digest('hex')}  ${BASE}.zip\n`);

  // Chrome loaded the extracted copy with the shipped manifest: same version,
  // exact permissions, no host access, icons in place.
  const extractedManifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
  expect(extractedManifest).toEqual(JSON.parse(await readFile(join(ROOT, 'public', 'manifest.json'), 'utf8')));
  const page = await session.openDashboard({ accept: false });
  const loaded = await page.evaluate(() => chrome.runtime.getManifest());
  expect(loaded).toMatchObject({ version: VERSION, permissions: ['storage', 'activeTab', 'scripting'] });
  expect(loaded.host_permissions ?? []).toEqual([]);
  expect(loaded.description!.length).toBeLessThanOrEqual(132);
  const iconSizes = await page.evaluate(async (paths) => {
    const sizes: number[] = [];
    for (const p of paths) {
      const img = new Image();
      img.src = chrome.runtime.getURL(p);
      await img.decode();
      sizes.push(img.naturalWidth);
    }
    return sizes;
  }, Object.values(loaded.icons ?? {}));
  expect(iconSizes).toEqual([16, 32, 48, 128]);
  // A fresh installation shows the data practices before anything else and stores nothing until Agree and continue.
  await expect(consentGate(page)).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(await page.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  const gatedPopup = await session.context!.newPage();
  await gatedPopup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await expect(gatedPopup.getByTestId('popup-locked')).toHaveAttribute('data-state', 'consent_required');
  await gatedPopup.close();
  await acceptViaUi(page);
  // Then it asks to protect the records, and stores only the receipt and the encrypted vault.
  await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
  expect(Object.keys(await page.evaluate(() => chrome.storage.local.get(null)))).toEqual([CONSENT_KEY]);
  await setupViaUi(page);
  expect(Object.keys(await page.evaluate(() => chrome.storage.local.get(null))).sort()).toEqual([CONSENT_KEY, VAULT_KEY]);

  // "Data and privacy" can be reread after agreeing.
  await page.getByText('Data and privacy', { exact: true }).click();
  await expect(page.getByTestId('privacy')).toContainText('How Refund Reconciler handles your data');
  await page.getByText('Data and privacy', { exact: true }).click();

  // The guide is reachable and closed by default.
  await expect(page.getByTestId('help')).not.toHaveAttribute('open');
  await page.getByText('How to use Refund Reconciler').click();
  await expect(page.getByTestId('help')).toContainText('Load synthetic demo');

  // Synthetic demo: load, then remove.
  await page.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(page.getByTestId('demo-cases').getByTestId('case-row').first()).toBeVisible();
  await page.getByRole('button', { name: 'Remove synthetic demo' }).click();
  await expect(page.getByTestId('demo-cases')).toHaveCount(0);

  // A real case with a confirmed receipt.
  await createCase(page, { orderRef: 'BETA-SMOKE-1', items: [{ label: 'Synthetic desk lamp', amount: '35.00' }] });
  await expect(page.locator('#case-heading')).toContainText('BETA-SMOKE-1');
  await recordForItem(page, 'Synthetic desk lamp', 'Confirm money received', '35.00', { reference: 'STMT-SMOKE' });
  const stored = (await decryptedRaw(page)) as {
    cases: { isDemo: boolean; orderRef?: string; items: { label: string }[]; entries: Record<string, unknown>[] }[];
  };
  expect(JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)))).not.toMatch(/Synthetic desk lamp|STMT-SMOKE/);
  expect(stored.cases).toHaveLength(1);
  expect(stored.cases[0]).toMatchObject({ isDemo: false, items: [{ label: 'Synthetic desk lamp' }] });
  const kinds = stored.cases[0]!.entries.map((e) => [e.kind, e.amountCents]);
  expect(kinds).toEqual([
    ['expectation', 3500],
    ['receipt', 3500],
  ]);

  // JSON backup download contains exactly the saved data.
  await page.getByRole('button', { name: '← All cases' }).click();
  await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^refund-reconciler-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/);
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup).toMatchObject({ format: 'refund-reconciler-backup', formatVersion: 1 });
  expect(backup.store).toEqual(stored);

  await page.locator('#export-close').click();

  // Lock now, then unlock with the passphrase.
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
  await expect(page.locator('#app')).not.toContainText('BETA-SMOKE-1');
  await unlockViaUi(page);
  await expect(page.getByTestId('case-row')).toContainText('BETA-SMOKE-1');

  // The toolbar popup page from the archive renders and points to the guide.
  const popup = await session.context!.newPage();
  await popup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await expect(popup.getByRole('button', { name: 'Capture selected refund text' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'How to use Refund Reconciler' })).toBeVisible();
});
