// Input checks and text extraction for the store handoff (`npm run store:handoff`).
//
// The handoff reuses files that earlier steps already built and verified: the
// beta ZIP with its .sha256 and report (artifacts/beta/) and the listing images
// with their report and capture record (artifacts/store-assets/). Nothing is
// rebuilt here. Every input is read from disk and cross-checked against its
// report, against the pinned tested package, and against the checkout, so a
// missing, stale, rebuilt or edited input fails instead of being bundled.
// Development tooling only; nothing here ships in the extension.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPngSize } from '../beta/png.ts';
import { PRODUCTION_PERMISSIONS, verifyExtensionFiles } from '../beta/verify.ts';
import { isRegularFileEntry, isSafeEntryName, readZip } from '../beta/zip.ts';
import { PROMO_TILE, SCREENSHOT, STORE_FILES, checkImage, measureStoreIcon } from '../store/checks.ts';

export class HandoffError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HandoffError(message);
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

const COMMIT = /^[0-9a-f]{40}$/;

/** The package the owner checks and uploads. Changing it is a deliberate edit, never a silent rebuild. */
export interface ExpectedPackage {
  file: string;
  version: string;
  name: string;
  bytes: number;
  sha256: string;
}

export interface HandoffInputs {
  zip: Buffer;
  sumText: string;
  betaReportText: string;
  assetsReportText: string;
  captureText: string;
  /** Listing images by file name, in STORE_FILES order. */
  images: Map<string, Buffer>;
}

export interface BetaReport {
  package: string;
  version: string;
  extensionName: string;
  sha256: string;
  bytes: number;
  sourceCommit: string | null;
  checkoutCommit: string | null;
  workingTreeClean: boolean | null;
  permissions: string[];
  files: { path: string; bytes: number; sha256: string }[];
}

export interface AssetsReport {
  generation: string;
  extension: { name: string; version: string; permissions: string[] };
  package: { file: string; bytes: number; sha256: string; sourceCommit: string | null; checkoutCommit: string | null };
  generatedFrom: { checkoutCommit: string | null; workingTreeClean: boolean | null };
  browser: { name: string; version: string };
  storeIcon: { path: string; sha256: string; bytes: number };
  outputs: { file: string; kind: string; width: number; height: number; bytes: number; sha256: string; scenario?: string }[];
}

export interface Provenance {
  /** The commit CI was asked to build (pull request head or pushed commit); null locally. */
  sourceCommit: string | null;
  /** `git rev-parse HEAD` of this checkout. */
  head: string | null;
  ci: boolean;
}

export interface VerifiedInputs {
  betaReport: BetaReport;
  assetsReport: AssetsReport;
  /** icons/icon-128.png exactly as packaged in the ZIP. */
  storeIcon: Buffer;
  images: { file: string; data: Buffer; width: number; height: number; kind: string; scenario: string | undefined }[];
}

async function readInput(path: string, label: string, hint: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HandoffError(`Missing input: ${label}. ${hint}`);
    throw err;
  }
}

/** Reads every input from the two artifact folders. Missing files fail with the command that makes them. */
export async function readInputs(betaDir: string, assetsDir: string, pkg: ExpectedPackage): Promise<HandoffInputs> {
  const base = pkg.file.replace(/\.zip$/, '');
  const betaHint = 'Run `npm run package:beta` (CI: test:package) first; the handoff never builds the package itself.';
  const assetsHint = 'Run `npm run assets:store -- --reuse-package` against the same beta ZIP first.';
  const text = async (path: string, label: string, hint: string) => (await readInput(path, label, hint)).toString('utf8');
  const images = new Map<string, Buffer>();
  for (const name of [STORE_FILES.tile, ...STORE_FILES.screenshots]) {
    images.set(name, await readInput(join(assetsDir, name), `artifacts/store-assets/${name}`, assetsHint));
  }
  return {
    zip: await readInput(join(betaDir, pkg.file), `artifacts/beta/${pkg.file}`, betaHint),
    sumText: await text(join(betaDir, `${pkg.file}.sha256`), `artifacts/beta/${pkg.file}.sha256`, betaHint),
    betaReportText: await text(join(betaDir, `${base}.report.json`), `artifacts/beta/${base}.report.json`, betaHint),
    assetsReportText: await text(join(assetsDir, STORE_FILES.report), `artifacts/store-assets/${STORE_FILES.report}`, assetsHint),
    captureText: await text(join(assetsDir, STORE_FILES.capture), `artifacts/store-assets/${STORE_FILES.capture}`, assetsHint),
    images,
  };
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HandoffError(`${label} is not valid JSON`);
  }
}

/**
 * Checks that the package is the pinned tested ZIP, that it agrees with its
 * checksum file and report file by file, that it is still a valid production
 * extension with the same permissions, and that the listing images were made
 * from that same ZIP in this checkout, in the documented order and sizes.
 */
export function verifyInputs(inputs: HandoffInputs, pkg: ExpectedPackage, prov: Provenance): VerifiedInputs {
  const digest = sha256(inputs.zip);
  check(
    digest === pkg.sha256,
    `${pkg.file} has SHA-256 ${digest}, not the tested package ${pkg.sha256}. The handoff only bundles the tested ZIP; a changed build needs its own owner check and a deliberate update of the expected hash.`,
  );
  check(inputs.zip.length === pkg.bytes, `${pkg.file} is ${inputs.zip.length} bytes, expected ${pkg.bytes}`);
  check(inputs.sumText === `${digest}  ${pkg.file}\n`, `${pkg.file}.sha256 does not name this ZIP and its hash`);

  // ---- Beta report ----
  const report = parseJson<BetaReport>(inputs.betaReportText, 'beta report');
  check(report.package === pkg.file, `beta report names ${String(report.package)}, not ${pkg.file}`);
  check(report.version === pkg.version, `beta report version ${String(report.version)} is not ${pkg.version}`);
  check(report.extensionName === pkg.name, `beta report extension name ${String(report.extensionName)} is not ${pkg.name}`);
  check(report.sha256 === digest, 'beta report SHA-256 does not match the ZIP');
  check(report.bytes === inputs.zip.length, 'beta report byte count does not match the ZIP');
  check(JSON.stringify(report.permissions) === JSON.stringify(PRODUCTION_PERMISSIONS), `beta report permissions ${JSON.stringify(report.permissions)} changed`);
  check(typeof report.sourceCommit === 'string' && COMMIT.test(report.sourceCommit), 'beta report has no source commit');
  check(typeof report.checkoutCommit === 'string' && COMMIT.test(report.checkoutCommit), 'beta report has no checkout commit');
  if (prov.head !== null) check(report.checkoutCommit === prov.head, `beta ZIP was built from checkout ${report.checkoutCommit}, not this checkout ${prov.head}`);
  if (prov.ci) {
    check(report.sourceCommit === prov.sourceCommit, `beta report source commit ${report.sourceCommit} is not this run's ${String(prov.sourceCommit)}`);
    check(report.workingTreeClean === true, 'beta ZIP was built from a dirty working tree');
  }

  // ---- The archive itself, file by file ----
  const files = new Map<string, Buffer>();
  for (const entry of readZip(inputs.zip)) {
    check(isSafeEntryName(entry.name) && isRegularFileEntry(entry), `unsafe or non-regular entry in ${pkg.file}: ${entry.name}`);
    check(!files.has(entry.name), `duplicate entry in ${pkg.file}: ${entry.name}`);
    files.set(entry.name, entry.data);
  }
  check(Array.isArray(report.files) && report.files.length === files.size, `beta report lists ${report.files?.length} files; the ZIP has ${files.size}`);
  for (const f of report.files) {
    const data = files.get(f.path);
    check(data, `beta report lists ${f.path}, which is not in the ZIP`);
    check(data.length === f.bytes && sha256(data) === f.sha256, `${f.path} in the ZIP does not match the beta report`);
  }
  // The production allowlist, manifest identity, version and exact permissions.
  const ext = verifyExtensionFiles(files, pkg.version);
  check(ext.name === pkg.name, `manifest name ${ext.name} is not ${pkg.name}`);

  // ---- Store-asset report and capture record ----
  const assets = parseJson<AssetsReport>(inputs.assetsReportText, 'store-assets report');
  const wantGeneration = prov.ci ? 'ci-final-head' : 'local';
  check(assets.generation === wantGeneration, `store-assets report is labelled ${String(assets.generation)}; this run needs ${wantGeneration} output from artifacts/store-assets/`);
  check(assets.package?.file === pkg.file && assets.package.sha256 === digest && assets.package.bytes === inputs.zip.length, 'store assets were generated from a different beta ZIP');
  check(assets.package.sourceCommit === report.sourceCommit && assets.package.checkoutCommit === report.checkoutCommit, 'store-assets report and beta report name different commits');
  if (prov.head !== null) check(assets.generatedFrom?.checkoutCommit === prov.head, `store assets were generated in checkout ${String(assets.generatedFrom?.checkoutCommit)}, not ${prov.head}`);
  check(
    assets.extension?.version === pkg.version && assets.extension.name === pkg.name && JSON.stringify(assets.extension.permissions) === JSON.stringify(PRODUCTION_PERMISSIONS),
    'store-assets report describes a different extension version, name or permissions',
  );
  const capture = parseJson<{ package?: { sha256?: string } }>(inputs.captureText, 'capture record');
  check(capture.package?.sha256 === digest, 'screenshots were captured from a different beta ZIP');

  const storeIcon = files.get('icons/icon-128.png');
  check(storeIcon, 'icons/icon-128.png is missing from the ZIP');
  check(assets.storeIcon?.path === 'icons/icon-128.png' && assets.storeIcon.sha256 === sha256(storeIcon), 'store-assets report describes a different 128 px icon');
  measureStoreIcon(storeIcon);

  const order = [STORE_FILES.tile, ...STORE_FILES.screenshots];
  check(Array.isArray(assets.outputs) && JSON.stringify(assets.outputs.map((o) => o.file)) === JSON.stringify(order), `store-assets outputs must be exactly ${order.join(', ')} in that order`);
  const images = assets.outputs.map((o, i) => {
    const data = inputs.images.get(o.file);
    check(data, `Missing input: artifacts/store-assets/${o.file}`);
    check(data.length === o.bytes && sha256(data) === o.sha256, `${o.file} does not match the store-assets report`);
    const size = i === 0 ? PROMO_TILE : SCREENSHOT;
    checkImage(data, size, o.file);
    check(o.width === size.width && o.height === size.height, `${o.file} report dimensions are wrong`);
    return { file: o.file, data, ...readPngSize(data), kind: o.kind, scenario: o.scenario };
  });

  return { betaReport: report, assetsReport: assets, storeIcon, images };
}

// ---- Text taken from the committed store documents ----

/** The body of a `## heading` section, up to the next `## ` heading. */
function section(md: string, heading: string, label: string): string {
  const text = md.replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n## ${heading}\n`);
  check(start >= 0, `${label} has no "## ${heading}" section`);
  const body = text.slice(start + heading.length + 5);
  const end = body.search(/\n## /);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

const plain = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '');

/**
 * The approved detailed description from docs/store/listing.md as paste-ready
 * plain text: bold and code marks removed, hard-wrapped lines joined (the
 * dashboard keeps line breaks), bullets kept as "- ".
 */
export function extractDescription(listingMd: string): string {
  const body = section(listingMd, 'Detailed description', 'docs/store/listing.md');
  const blocks = body.split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim());
    if (!lines[0]?.startsWith('- ')) return plain(lines.join(' '));
    const items: string[] = [];
    for (const line of lines) {
      if (line.startsWith('- ')) items.push(line);
      else items[items.length - 1] += ` ${line}`;
    }
    return items.map(plain).join('\n');
  });
  const text = `${blocks.join('\n\n')}\n`;
  check(!/^>|\]\(|<\?|TODO|\bdraft\b|not verified|readiness/im.test(text), 'the detailed description contains document notes or links, not only listing copy');
  for (const phrase of [
    'Optional: capture a refund line',
    'not on real Amazon refund pages',
    'Backups, summaries and copied text are ordinary, unencrypted plaintext.',
    'There is no recovery service:',
    'Everything stays in this Chrome profile',
  ]) {
    check(text.includes(phrase), `the detailed description no longer contains: ${phrase}`);
  }
  return text;
}

/** The first `> ` quoted paragraph after `heading` (a paste-ready answer in privacy-practices.md). */
export function extractQuote(md: string, heading: string): string {
  const text = md.replace(/\r\n/g, '\n');
  const at = text.indexOf(heading);
  check(at >= 0, `docs/store/privacy-practices.md has no "${heading}"`);
  const lines = text.slice(at).split('\n');
  const first = lines.findIndex((l) => l.startsWith('> '));
  check(first > 0, `no quoted answer after "${heading}"`);
  const quoted: string[] = [];
  for (const l of lines.slice(first)) {
    if (!l.startsWith('>')) break;
    quoted.push(l.replace(/^>\s?/, '').trim());
  }
  return quoted.join(' ').trim();
}

/** Replaces every {{KEY}}; unknown keys and leftover braces fail. */
export function renderTemplate(template: string, vars: Record<string, string>, label: string): string {
  const out = template.replace(/\r\n/g, '\n').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    check(value !== undefined, `${label} uses unknown placeholder {{${key}}}`);
    return value;
  });
  check(!/\{\{|\}\}/.test(out), `${label} has an unreplaced placeholder`);
  return out;
}
