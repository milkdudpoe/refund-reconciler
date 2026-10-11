// Chrome Web Store listing images: `npm run assets:store`.
//
//   1. `npm run package:beta` (skipped with --reuse-package, which uses the
//      verified ZIP already in artifacts/beta/, as CI does after its checks).
//   2. Playwright (playwright.store.config.ts): renders the small promotional
//      tile from store-assets/source/small-promo-tile.svg and captures three
//      screenshots from the extracted beta ZIP in a disposable profile.
//   3. Validates every output and writes a provenance report and an offline
//      preview page.
//
// Output (git-ignored): artifacts/store-assets/. Only the named files below are
// ever replaced; nothing is deleted recursively. Listing images are never part
// of the extension: the beta ZIP's own allowlist (scripts/beta/verify.ts)
// rejects them, and this script checks the ZIP inventory again.
//
// `--promote` copies an existing local run into store-assets/ (committed),
// relabelled "local-precommit". It never runs in CI and never claims final-head
// output; the CI artifact is the final-head record.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { readPngSize } from './beta/png.ts';
import { readZip } from './beta/zip.ts';
import { PROMO_TILE, SCREENSHOT, SCREENSHOT_COUNT, STORE_FILES, checkImage, measureStoreIcon } from './store/checks.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'artifacts', 'store-assets');
const COMMITTED = join(ROOT, 'store-assets');
const args = new Set(process.argv.slice(2));

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function git(gitArgs: string[]): string | null {
  const r = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function inside(dir: string, name: string): string {
  const path = resolve(dir, name);
  if (dirname(path) !== dir || !path.startsWith(ROOT + sep)) throw new Error(`Refusing path outside ${dir}: ${name}`);
  return path;
}

function run(command: string, commandArgs: string[], env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`${[command, ...commandArgs].join(' ')} failed (exit ${String(r.status)})`);
}

interface Capture {
  package: { file: string; sha256: string; sourceCommit: string | null };
  extension: { name: string; version: string; permissions: string[] };
  browser: { name: string; version: string };
  capture: Record<string, unknown>;
  verified: Record<string, number>;
  screenshots: { file: string; bytes: number; sha256: string; scenario: string }[];
}

interface Report {
  generation: 'ci-final-head' | 'local' | 'local-precommit';
  generationNote: string;
  extension: Capture['extension'];
  dataPracticesVersion: number;
  package: { file: string; bytes: number; sha256: string; sourceCommit: string | null; checkoutCommit: string | null; workingTreeClean: boolean | null };
  generatedFrom: { checkoutCommit: string | null; workingTreeClean: boolean | null; dirtyPaths: string[] };
  browser: Capture['browser'];
  node: string;
  capture: Capture['capture'];
  verifiedScenario: Capture['verified'];
  storeIcon: { path: string; sha256: string; bytes: number } & ReturnType<typeof measureStoreIcon>;
  outputs: { file: string; kind: string; width: number; height: number; bytes: number; sha256: string; scenario?: string }[];
  hashesNote: string;
}

async function generate(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const base = `refund-reconciler-beta-${pkg.version}`;
  await mkdir(OUT, { recursive: true });
  for (const name of [STORE_FILES.tile, ...STORE_FILES.screenshots, STORE_FILES.capture, STORE_FILES.report, STORE_FILES.preview]) {
    await rm(inside(OUT, name), { force: true });
  }

  if (!args.has('--reuse-package')) run(process.execPath, ['--experimental-strip-types', join(ROOT, 'scripts', 'package-beta.ts')]);
  const playwrightCli = join(dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json')), 'cli.js');
  run(process.execPath, [playwrightCli, 'test', '-c', 'playwright.store.config.ts']);

  // ---- Validate ----
  const zip = await readFile(join(ROOT, 'artifacts', 'beta', `${base}.zip`));
  const betaReport = JSON.parse(await readFile(join(ROOT, 'artifacts', 'beta', `${base}.report.json`), 'utf8')) as {
    sha256: string;
    bytes: number;
    sourceCommit: string | null;
    checkoutCommit: string | null;
    workingTreeClean: boolean | null;
  };
  const zipDigest = sha256(zip);
  if (betaReport.sha256 !== zipDigest) throw new Error('beta ZIP does not match its report');
  const cap = JSON.parse(await readFile(inside(OUT, STORE_FILES.capture), 'utf8')) as Capture;
  if (cap.package.sha256 !== zipDigest) throw new Error('screenshots were captured from a different beta ZIP than the one in artifacts/beta/');

  // The ZIP contains the padded store icon and the unchanged toolbar icons, and no listing material.
  const entries = new Map(readZip(zip).map((e) => [e.name, e.data]));
  for (const size of [16, 32, 48, 128]) {
    const committed = await readFile(join(ROOT, 'public', 'icons', `icon-${size}.png`));
    if (!entries.get(`icons/icon-${size}.png`)?.equals(committed)) throw new Error(`icons/icon-${size}.png in the ZIP differs from public/icons`);
  }
  for (const name of entries.keys()) {
    if (/store-assets|screenshot|promo|report|preview|profile|\.svg$/i.test(name)) throw new Error(`listing or test material in the beta ZIP: ${name}`);
  }
  const iconBytes = entries.get('icons/icon-128.png');
  if (!iconBytes) throw new Error('icons/icon-128.png is missing from the beta ZIP');
  const icon = measureStoreIcon(iconBytes);

  const outputs: Report['outputs'] = [];
  const tile = await readFile(inside(OUT, STORE_FILES.tile));
  checkImage(tile, PROMO_TILE, STORE_FILES.tile);
  outputs.push({ file: STORE_FILES.tile, kind: 'small promotional tile', ...readPngSize(tile), bytes: tile.length, sha256: sha256(tile) });
  if (cap.screenshots.length !== SCREENSHOT_COUNT) throw new Error(`expected ${SCREENSHOT_COUNT} screenshots, found ${cap.screenshots.length}`);
  for (const [i, name] of STORE_FILES.screenshots.entries()) {
    const png = await readFile(inside(OUT, name));
    checkImage(png, SCREENSHOT, name);
    const shot = cap.screenshots[i];
    if (!shot || shot.file !== name || shot.sha256 !== sha256(png)) throw new Error(`${name} does not match the capture record`);
    outputs.push({ file: name, kind: `screenshot ${i + 1}`, ...readPngSize(png), bytes: png.length, sha256: shot.sha256, scenario: shot.scenario });
  }

  const head = git(['rev-parse', 'HEAD']);
  const dirty = head === null ? [] : (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean);
  const ci = process.env.GITHUB_ACTIONS === 'true' && !!process.env.BETA_SOURCE_COMMIT;
  const practices = await readFile(join(ROOT, 'src', 'consent', 'practices.ts'), 'utf8');
  const practicesVersion = Number(/DATA_PRACTICES_VERSION\s*=\s*(\d+)/.exec(practices)?.[1]);
  const report: Report = {
    generation: ci ? 'ci-final-head' : 'local',
    generationNote: ci
      ? `Generated by CI for source commit ${process.env.BETA_SOURCE_COMMIT ?? ''} (the pull request head or pushed commit).`
      : 'Generated locally; not a CI final-head record.',
    extension: cap.extension,
    dataPracticesVersion: practicesVersion,
    package: {
      file: `${base}.zip`,
      bytes: zip.length,
      sha256: zipDigest,
      sourceCommit: betaReport.sourceCommit,
      checkoutCommit: betaReport.checkoutCommit,
      workingTreeClean: betaReport.workingTreeClean,
    },
    generatedFrom: { checkoutCommit: head, workingTreeClean: head === null ? null : dirty.length === 0, dirtyPaths: dirty },
    browser: cap.browser,
    node: process.version,
    capture: cap.capture,
    verifiedScenario: cap.verified,
    storeIcon: { path: 'icons/icon-128.png', sha256: sha256(iconBytes), bytes: iconBytes.length, ...icon },
    outputs,
    hashesNote: 'SHA-256 values identify these exact files for artifact integrity. Rendering differs across operating systems and fonts, so they are not a visual-correctness check and are not compared across runs.',
  };
  await writeFile(inside(OUT, STORE_FILES.report), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(inside(OUT, STORE_FILES.preview), previewHtml(report, iconBytes));

  console.log(`\nStore assets verified (${report.generation}) from ${report.package.file} sha256 ${zipDigest}`);
  console.log(`  store icon: artwork x ${icon.alphaBounds.left}-${icon.alphaBounds.right}, y ${icon.alphaBounds.top}-${icon.alphaBounds.bottom}, transparent margin >= ${icon.minTransparentMargin} px`);
  for (const o of outputs) console.log(`  artifacts/store-assets/${o.file}  ${o.width}x${o.height}  ${o.bytes} bytes  ${o.sha256}`);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An offline contact sheet: local files and an inline data URI only, no external resources. */
function previewHtml(report: Report, icon: Uint8Array): string {
  const iconSrc = `data:image/png;base64,${Buffer.from(icon).toString('base64')}`;
  const shots = report.outputs.filter((o) => o.kind.startsWith('screenshot'));
  const tile = report.outputs.find((o) => o.kind === 'small promotional tile');
  if (!tile) throw new Error('the report lists no promotional tile');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<title>Store assets preview</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #1f2933; background: #fff; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
  .bg { padding: 12px; } .light { background: #fff; border: 1px solid #ddd; } .dark { background: #202124; } .grey { background: #8a8f98; }
  img { display: block; } figure { margin: 0; } figcaption { font-size: 12px; color: #52606d; margin-top: 4px; max-width: 640px; }
  code { font-size: 12px; }
</style>
</head>
<body>
<h1>Refund Reconciler ${escapeHtml(report.extension.version)}: store assets preview</h1>
<p>Generation: <strong>${escapeHtml(report.generation)}</strong>. ${escapeHtml(report.generationNote)}<br>
Package <code>${escapeHtml(report.package.file)}</code> sha256 <code>${escapeHtml(report.package.sha256)}</code>, source commit <code>${escapeHtml(String(report.package.sourceCommit))}</code>.<br>
Browser: ${escapeHtml(report.browser.name)} ${escapeHtml(report.browser.version)}.</p>

<h2>Store icon (icons/icon-128.png from the ZIP)</h2>
<div class="row">
  <figure><div class="bg light"><img src="${iconSrc}" width="128" height="128" alt="Store icon on light"></div><figcaption>128 px, light</figcaption></figure>
  <figure><div class="bg dark"><img src="${iconSrc}" width="128" height="128" alt="Store icon on dark"></div><figcaption>128 px, dark</figcaption></figure>
  <figure><div class="bg light"><img src="${iconSrc}" width="64" height="64" alt="Store icon at 64 px"></div><figcaption>64 px</figcaption></figure>
  <figure><div class="bg dark"><img src="${iconSrc}" width="48" height="48" alt="Store icon at 48 px on dark"></div><figcaption>48 px, dark</figcaption></figure>
  <figure><div class="bg grey"><img src="${iconSrc}" width="32" height="32" alt="Store icon at 32 px on grey"></div><figcaption>32 px, grey</figcaption></figure>
</div>
<p>Artwork bounds x ${report.storeIcon.alphaBounds.left}–${report.storeIcon.alphaBounds.right}, y ${report.storeIcon.alphaBounds.top}–${report.storeIcon.alphaBounds.bottom} (${report.storeIcon.artworkWidth}×${report.storeIcon.artworkHeight}); fully transparent margin ≥ ${report.storeIcon.minTransparentMargin} px.</p>

<h2>Small promotional tile</h2>
<div class="row">
  <figure><img src="${escapeHtml(tile.file)}" width="440" height="280" alt="Small promotional tile"><figcaption>440×280</figcaption></figure>
  <figure><img src="${escapeHtml(tile.file)}" width="220" height="140" alt="Small promotional tile at half size"><figcaption>half size, 220×140</figcaption></figure>
</div>

<h2>Screenshots, shown at 640×400</h2>
${shots
  .map(
    (s) => `<figure><img src="${escapeHtml(s.file)}" width="640" height="400" alt="${escapeHtml(s.kind)}"><figcaption><code>${escapeHtml(s.file)}</code> (${s.width}×${s.height}). ${escapeHtml(s.scenario ?? '')}</figcaption></figure>`,
  )
  .join('\n<br>\n')}
</body>
</html>
`;
}

async function promote(): Promise<void> {
  const report = JSON.parse(await readFile(inside(OUT, STORE_FILES.report), 'utf8')) as Report;
  if (report.generation !== 'local') throw new Error(`refusing to promote a ${report.generation} run; promote only a local run`);
  if (process.env.GITHUB_ACTIONS === 'true') throw new Error('--promote is a local step; CI publishes its own artifact');
  await mkdir(COMMITTED, { recursive: true });
  for (const o of report.outputs) await copyFile(inside(OUT, o.file), inside(COMMITTED, o.file));
  const promoted: Report = {
    ...report,
    generation: 'local-precommit',
    generationNote:
      'Generated locally before these files were committed, from the checkout recorded in generatedFrom. This is not CI final-head output: the CI "refund-reconciler-store-assets" artifact for the pull request head is the final-head record.',
  };
  await writeFile(inside(COMMITTED, STORE_FILES.report), `${JSON.stringify(promoted, null, 2)}\n`);
  const icon = await readFile(join(ROOT, 'public', 'icons', 'icon-128.png'));
  if (sha256(icon) !== report.storeIcon.sha256) throw new Error('public/icons/icon-128.png changed since this run');
  await writeFile(inside(COMMITTED, STORE_FILES.preview), previewHtml(promoted, icon));
  console.log(`Copied ${report.outputs.length} images, ${STORE_FILES.report} and ${STORE_FILES.preview} to store-assets/ (local-precommit).`);
}

await (args.has('--promote') ? promote() : generate());
