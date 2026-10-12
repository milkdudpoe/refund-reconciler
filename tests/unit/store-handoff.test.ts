// Store handoff (scripts/store-handoff.ts): the committed texts render
// completely, and the input checks refuse a changed, mismatched or
// differently sourced package or image set. The fixture extension is a small
// valid production file set built in memory, pinned as the "tested" package.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createZip } from '../../scripts/beta/zip.ts';
import { type ExpectedPackage, type HandoffInputs, extractDescription, extractQuote, renderTemplate, sha256, verifyInputs } from '../../scripts/handoff/inputs.ts';
import { STORE_FILES } from '../../scripts/store/checks.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFile(join(ROOT, p));
const COMMIT = 'a'.repeat(40);

const files = new Map<string, Buffer>([
  ['manifest.json', await read('public/manifest.json')],
  ...(await Promise.all([16, 32, 48, 128].map(async (n) => [`icons/icon-${n}.png`, await read(`public/icons/icon-${n}.png`)] as [string, Buffer]))),
  ['popup.html', Buffer.from('<!doctype html><script type="module" src="./popup.js"></script>')],
  ['dashboard.html', Buffer.from('<!doctype html><script type="module" src="./dashboard.js"></script>')],
  ['popup.js', Buffer.from('chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${h}`) });')],
  ['dashboard.js', Buffer.from('export {};')],
  ['background.js', Buffer.from('export {};')],
]);
const zip = createZip([...files].map(([name, data]) => ({ name, data })));
const PKG: ExpectedPackage = { file: 'refund-reconciler-beta-0.8.0.zip', version: '0.8.0', name: 'Refund Reconciler (local preview)', bytes: zip.length, sha256: sha256(zip) };
const PROV = { sourceCommit: COMMIT, head: COMMIT, ci: true };

async function inputs(): Promise<HandoffInputs> {
  const images = new Map<string, Buffer>();
  for (const f of [STORE_FILES.tile, ...STORE_FILES.screenshots]) images.set(f, await read(`store-assets/${f}`));
  const committed = JSON.parse((await read('store-assets/store-assets-report.json')).toString('utf8'));
  const pkg = { file: PKG.file, bytes: zip.length, sha256: PKG.sha256, sourceCommit: COMMIT, checkoutCommit: COMMIT };
  return {
    zip,
    sumText: `${PKG.sha256}  ${PKG.file}\n`,
    betaReportText: JSON.stringify({
      package: PKG.file, version: '0.8.0', extensionName: PKG.name, sha256: PKG.sha256, bytes: zip.length,
      sourceCommit: COMMIT, checkoutCommit: COMMIT, workingTreeClean: true, permissions: ['storage', 'activeTab', 'scripting'],
      files: [...files].map(([path, data]) => ({ path, bytes: data.length, sha256: sha256(data) })),
    }),
    assetsReportText: JSON.stringify({ ...committed, generation: 'ci-final-head', package: pkg, generatedFrom: { checkoutCommit: COMMIT, workingTreeClean: true } }),
    captureText: JSON.stringify({ package: { sha256: PKG.sha256 } }),
    images,
  };
}

function edit(text: string, change: (d: Record<string, any>) => void): string {
  const d = JSON.parse(text);
  change(d);
  return JSON.stringify(d);
}

describe('store handoff input checks', () => {
  it('accept the pinned package with matching reports and images', async () => {
    const v = verifyInputs(await inputs(), PKG, PROV);
    expect(v.images.map((i) => i.file)).toEqual([STORE_FILES.tile, ...STORE_FILES.screenshots]);
    expect(v.storeIcon.equals(files.get('icons/icon-128.png')!)).toBe(true);
  });

  it.each<[string, (i: HandoffInputs) => void, RegExp]>([
    ['a rebuilt or changed ZIP', (i) => { i.zip = Buffer.concat([i.zip, Buffer.from('x')]); }, /not the tested package/],
    ['a checksum file for another ZIP', (i) => { i.sumText = `${'0'.repeat(64)}  ${PKG.file}\n`; }, /\.sha256 does not name/],
    ['a report with another version', (i) => { i.betaReportText = edit(i.betaReportText, (d) => { d.version = '0.8.1'; }); }, /version 0\.8\.1/],
    ['a report from another checkout', (i) => { i.betaReportText = edit(i.betaReportText, (d) => { d.checkoutCommit = 'b'.repeat(40); }); }, /not this checkout/],
    ['a report from another run', (i) => { i.betaReportText = edit(i.betaReportText, (d) => { d.sourceCommit = 'c'.repeat(40); }); }, /not this run's/],
    ['a report whose file list differs', (i) => { i.betaReportText = edit(i.betaReportText, (d) => { d.files[0].sha256 = '0'.repeat(64); }); }, /does not match the beta report/],
    ['images from another ZIP', (i) => { i.assetsReportText = edit(i.assetsReportText, (d) => { d.package.sha256 = '0'.repeat(64); }); }, /different beta ZIP/],
    ['committed local-precommit images', (i) => { i.assetsReportText = edit(i.assetsReportText, (d) => { d.generation = 'local-precommit'; }); }, /labelled local-precommit/],
    ['a capture record from another ZIP', (i) => { i.captureText = '{"package":{"sha256":"0"}}'; }, /captured from a different/],
    ['a swapped screenshot', (i) => { i.images.set(STORE_FILES.screenshots[1], i.images.get(STORE_FILES.screenshots[0])!); }, /does not match the store-assets report/],
  ])('refuse %s', async (_, change, message) => {
    const i = await inputs();
    change(i);
    expect(() => verifyInputs(i, PKG, PROV)).toThrow(message);
  });
});

describe('store handoff texts', () => {
  it('extract the approved description as plain text with its limitations', async () => {
    const text = extractDescription((await read('docs/store/listing.md')).toString('utf8'));
    expect(text).not.toMatch(/\*\*|`|^>|Draft|Reviewer instructions/m);
    expect(text).toContain('not on real Amazon refund pages');
    expect(() => extractDescription('# Listing\n\n## Detailed description\n\nDraft text.\n')).toThrow(/document notes/);
  });

  it('render every committed template completely', async () => {
    const practices = (await read('docs/store/privacy-practices.md')).toString('utf8');
    expect(extractQuote(practices, '**`scripting`**')).toMatch(/^After the user chooses Capture/);
    const keys = ['VERSION', 'EXTENSION_NAME', 'PACKAGE_FILE', 'PACKAGE_BYTES', 'PACKAGE_SHA256', 'MANIFEST_DESCRIPTION', 'MANIFEST_DESCRIPTION_LENGTH', 'OUTER_FILE',
      'SINGLE_PURPOSE', 'JUSTIFY_STORAGE', 'JUSTIFY_ACTIVETAB', 'JUSTIFY_SCRIPTING', 'HOMEPAGE_URL', 'POLICY_URL', 'SUPPORT_URL', 'PUBLISHER', 'CONTACT', 'DOCS_CHECKED'];
    const vars = Object.fromEntries(keys.map((k) => [k, 'x']));
    for (const name of await readdir(join(ROOT, 'docs/store/handoff'))) {
      const out = renderTemplate((await read(`docs/store/handoff/${name}`)).toString('utf8'), vars, name);
      expect(out).not.toMatch(/\{\{|\}\}/);
    }
    expect(() => renderTemplate('{{NOPE}}', vars, 't')).toThrow(/unknown placeholder/);
  });
});
