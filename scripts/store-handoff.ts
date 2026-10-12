// Chrome Web Store handoff for the owner: `npm run store:handoff`.
//
// Bundles, without rebuilding anything, the tested beta ZIP and the listing
// images that earlier steps already produced and verified in this checkout
// (CI: the same job), plus paste-ready listing, reviewer and privacy text and
// the owner's instructions (docs/store/submission-handoff.md). Inputs:
//
//   artifacts/beta/refund-reconciler-beta-<version>.{zip,zip.sha256,report.json}
//   artifacts/store-assets/{4 PNGs, store-assets-report.json, capture.json}
//   docs/store/listing.md (detailed description), docs/store/privacy-practices.md
//   (single purpose, permission justifications), docs/store/handoff/* (templates)
//
// Output (git-ignored), only these named files are replaced:
//
//   artifacts/store-handoff/refund-reconciler-store-handoff-<version>.zip
//   artifacts/store-handoff/refund-reconciler-store-handoff-<version>.zip.sha256
//   artifacts/store-handoff/store-handoff-report.json
//
// The outer ZIP is a folder of documents for a person, not an extension: the
// only file to upload is extension/refund-reconciler-beta-<version>.zip inside
// it, byte for byte the tested package. This script uploads, submits and
// contacts nothing.

import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createZip, readZip } from './beta/zip.ts';
import { HandoffError, type ExpectedPackage, extractDescription, extractQuote, readInputs, renderTemplate, sha256, verifyInputs } from './handoff/inputs.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'artifacts', 'store-handoff');
const TEMPLATES = join(ROOT, 'docs', 'store', 'handoff');

/**
 * The tested beta package (Task 11 owner-check package; every later CI build
 * is byte-identical). A different build is refused: it would need its own
 * owner check before it could be handed off.
 */
const PACKAGE: ExpectedPackage = {
  file: 'refund-reconciler-beta-0.8.0.zip',
  version: '0.8.0',
  name: 'Refund Reconciler (local preview)',
  bytes: 85563,
  sha256: '79cc8f5ebae2780723ab4b4ba84b9d6a64f0462548b523476a3a46eb8365bfd8',
};

const SITE = {
  HOMEPAGE_URL: 'https://milkdudpoe.github.io/refund-reconciler/',
  POLICY_URL: 'https://milkdudpoe.github.io/refund-reconciler/privacy.html',
  SUPPORT_URL: 'https://milkdudpoe.github.io/refund-reconciler/support.html',
  PUBLISHER: 'MJUD',
  CONTACT: 'exiledeals@gmail.com',
};
/** When the Chrome Web Store documentation cited in the templates was last read. */
const DOCS_CHECKED = '2026-10-12';

const OUTER = `refund-reconciler-store-handoff-${PACKAGE.version}.zip`;
const INVENTORY = 'inventory.json';

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function outPath(name: string): string {
  const path = resolve(OUT, name);
  if (dirname(path) !== OUT || !path.startsWith(ROOT + sep)) throw new Error(`Refusing output path outside artifacts/store-handoff: ${name}`);
  return path;
}

async function main(): Promise<void> {
  for (const name of [OUTER, `${OUTER}.tmp`, `${OUTER}.sha256`, 'store-handoff-report.json']) await rm(outPath(name), { force: true });

  const head = git(['rev-parse', 'HEAD']);
  const dirty = head === null ? [] : (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean);
  const ci = process.env.GITHUB_ACTIONS === 'true' && !!process.env.BETA_SOURCE_COMMIT;
  const sourceCommit = ci ? (process.env.BETA_SOURCE_COMMIT as string) : null;

  // 1. Read and verify the existing outputs; nothing is rebuilt.
  const inputs = await readInputs(join(ROOT, 'artifacts', 'beta'), join(ROOT, 'artifacts', 'store-assets'), PACKAGE);
  const v = verifyInputs(inputs, PACKAGE, { sourceCommit, head, ci });
  const manifest = JSON.parse(
    (readZip(inputs.zip).find((e) => e.name === 'manifest.json')?.data ?? Buffer.from('{}')).toString('utf8'),
  ) as { description: string };

  // 2. Paste-ready text from the committed store documents and templates.
  const practices = await readFile(join(ROOT, 'docs', 'store', 'privacy-practices.md'), 'utf8');
  const vars: Record<string, string> = {
    ...SITE,
    DOCS_CHECKED,
    VERSION: PACKAGE.version,
    EXTENSION_NAME: PACKAGE.name,
    PACKAGE_FILE: PACKAGE.file,
    PACKAGE_BYTES: String(PACKAGE.bytes),
    PACKAGE_SHA256: PACKAGE.sha256,
    MANIFEST_DESCRIPTION: manifest.description,
    MANIFEST_DESCRIPTION_LENGTH: String(manifest.description.length),
    OUTER_FILE: OUTER,
    SINGLE_PURPOSE: extractQuote(practices, '## Single purpose description'),
    JUSTIFY_STORAGE: extractQuote(practices, '**`storage`**'),
    JUSTIFY_ACTIVETAB: extractQuote(practices, '**`activeTab`**'),
    JUSTIFY_SCRIPTING: extractQuote(practices, '**`scripting`**'),
  };
  const template = async (name: string) => renderTemplate(await readFile(join(TEMPLATES, name), 'utf8'), vars, `docs/store/handoff/${name}`);
  const description = extractDescription(await readFile(join(ROOT, 'docs', 'store', 'listing.md'), 'utf8'));

  const base = PACKAGE.file.replace(/\.zip$/, '');
  const text = (s: string) => Buffer.from(s, 'utf8');
  const files: { path: string; data: Buffer; source: string }[] = [
    { path: 'OWNER-START-HERE.md', data: text(await template('OWNER-START-HERE.md')), source: 'docs/store/handoff/OWNER-START-HERE.md' },
    { path: 'listing-description.txt', data: text(description), source: 'docs/store/listing.md, "Detailed description" (markdown marks removed)' },
    { path: 'reviewer-instructions.txt', data: text(await template('reviewer-instructions.txt')), source: 'docs/store/handoff/reviewer-instructions.txt' },
    { path: 'privacy-and-permissions.md', data: text(await template('privacy-and-permissions.md')), source: 'docs/store/handoff/privacy-and-permissions.md, with answers quoted from docs/store/privacy-practices.md' },
    { path: `extension/${PACKAGE.file}`, data: inputs.zip, source: `artifacts/beta/${PACKAGE.file} (unchanged)` },
    { path: `extension/${PACKAGE.file}.sha256`, data: text(inputs.sumText), source: `artifacts/beta/${PACKAGE.file}.sha256 (unchanged)` },
    { path: `extension/${base}.report.json`, data: text(inputs.betaReportText), source: `artifacts/beta/${base}.report.json (unchanged)` },
    { path: 'images/README.txt', data: text(await template('images-README.txt')), source: 'docs/store/handoff/images-README.txt (order and captions from docs/store/assets.md)' },
    { path: 'images/icon-128.png', data: v.storeIcon, source: `icons/icon-128.png extracted unchanged from ${PACKAGE.file}` },
    ...v.images.map((img) => ({ path: `images/${img.file}`, data: img.data, source: `artifacts/store-assets/${img.file} (unchanged)` })),
    { path: 'images/store-assets-report.json', data: text(inputs.assetsReportText), source: 'artifacts/store-assets/store-assets-report.json (unchanged)' },
  ];

  // No machine paths or link secrets in anything we wrote or copied as text.
  const forbidden = [ROOT, homedir(), tmpdir(), '/home/', '/Users/', 'C:\\', 'X-Amz-', 'sig=', 'token='].filter((s) => s.length > 1);
  for (const f of files) {
    if (f.path.endsWith('.png') || f.path.endsWith('.zip')) continue;
    const body = f.data.toString('utf8');
    for (const s of forbidden) if (body.includes(s)) throw new HandoffError(`${f.path} contains a machine path or secret-like text (${s})`);
  }

  const run = ci && process.env.GITHUB_RUN_ID
    ? {
        id: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${process.env.GITHUB_REPOSITORY ?? ''}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      }
    : null;
  const provenance = {
    generation: ci ? 'ci-final-head' : 'local',
    generationNote: ci
      ? `Assembled by CI in the same job that built and verified the beta ZIP and store images, for source commit ${sourceCommit ?? ''}.`
      : 'Assembled locally from local outputs; not a CI final-head record.',
    sourceCommit: v.betaReport.sourceCommit,
    checkoutCommit: head,
    workingTreeClean: head === null ? null : dirty.length === 0,
    run,
    package: { file: PACKAGE.file, version: PACKAGE.version, extensionName: PACKAGE.name, bytes: PACKAGE.bytes, sha256: PACKAGE.sha256, permissions: v.betaReport.permissions },
    storeAssets: { generation: v.assetsReport.generation, browser: v.assetsReport.browser },
    docsChecked: DOCS_CHECKED,
  };
  const inventory = {
    note: `Every file in ${OUTER} except ${INVENTORY} itself. The checksum of ${OUTER} is beside the archive (${OUTER}.sha256), not inside it. Only extension/${PACKAGE.file} is uploaded to the Chrome Web Store; this outer archive is not an installable extension.`,
    excludes: [INVENTORY],
    ...provenance,
    files: files.map((f) => ({ path: f.path, bytes: f.data.length, sha256: sha256(f.data), source: f.source })),
  };
  const inventoryBytes = text(`${JSON.stringify(inventory, null, 2)}\n`);
  const entries = [...files.map((f) => ({ name: f.path, data: f.data })), { name: INVENTORY, data: inventoryBytes }];

  // 3. Write, read back, verify, then rename into place.
  await mkdir(OUT, { recursive: true });
  await writeFile(outPath(`${OUTER}.tmp`), createZip(entries));
  const written = await readFile(outPath(`${OUTER}.tmp`));
  const back = new Map(readZip(written).map((e) => [e.name, e.data]));
  if (back.size !== entries.length) throw new HandoffError('handoff archive has an unexpected number of entries');
  for (const e of entries) if (!back.get(e.name)?.equals(e.data)) throw new HandoffError(`handoff archive copy of ${e.name} differs`);
  if (back.has('manifest.json')) throw new HandoffError('the handoff archive must not look like an extension (manifest.json at its root)');
  if (sha256(back.get(`extension/${PACKAGE.file}`) as Buffer) !== PACKAGE.sha256) throw new HandoffError('the bundled extension ZIP changed');
  await rename(outPath(`${OUTER}.tmp`), outPath(OUTER));

  const outerSha = sha256(written);
  await writeFile(outPath(`${OUTER}.sha256`), `${outerSha}  ${OUTER}\n`);
  const report = {
    ...provenance,
    handoff: { file: OUTER, bytes: written.length, sha256: outerSha },
    inventory: { path: INVENTORY, bytes: inventoryBytes.length, sha256: sha256(inventoryBytes) },
    files: inventory.files,
    note: 'Prepared for the owner. Not uploaded, submitted, approved or published.',
  };
  await writeFile(outPath('store-handoff-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\nStore handoff assembled (${provenance.generation}), ${entries.length} files:`);
  for (const f of inventory.files) console.log(`  ${f.sha256}  ${String(f.bytes).padStart(7)}  ${f.path}`);
  console.log(`  ${report.inventory.sha256}  ${String(report.inventory.bytes).padStart(7)}  ${INVENTORY} (not listed in itself)`);
  console.log(`\nartifacts/store-handoff/${OUTER}\n  sha256 ${outerSha}  (${written.length} bytes)`);
  console.log(`Upload only: extension/${PACKAGE.file}  sha256 ${PACKAGE.sha256}`);
}

try {
  await main();
} catch (err) {
  // Input and package checks throw ordinary errors too; every failure refuses.
  console.error(`\nstore:handoff refused: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
