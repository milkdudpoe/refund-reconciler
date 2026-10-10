// Builds a fresh production extension and packages it as an installable beta
// ZIP: `npm run package:beta`.
//
// Output (all in artifacts/beta/, which is git-ignored):
//   refund-reconciler-beta-<version>.zip          manifest.json at the root
//   refund-reconciler-beta-<version>.zip.sha256   `sha256sum -c` format
//   refund-reconciler-beta-<version>.report.json  version, source commit, file inventory
//
// Only these three named files are ever replaced; nothing is deleted
// recursively. The archive is first written under a temporary name, read back
// from disk and verified, and only then renamed into place, so a failed run
// leaves no archive that looks successful.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { collectProductionFiles, verifyArchive, verifyExtensionFiles } from './beta/verify.ts';
import { createZip } from './beta/zip.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'artifacts', 'beta');

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Refuses any output path that is not directly inside artifacts/beta/. */
function outputPath(name: string): string {
  const path = resolve(OUT_DIR, name);
  if (dirname(path) !== OUT_DIR || !path.startsWith(ROOT + sep)) throw new Error(`Refusing output path outside artifacts/beta: ${name}`);
  return path;
}

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const source = JSON.parse(await readFile(join(ROOT, 'public', 'manifest.json'), 'utf8')) as { version: string };
if (pkg.version !== source.version) throw new Error(`package.json version ${pkg.version} differs from public/manifest.json ${source.version}`);
const base = `refund-reconciler-beta-${pkg.version}`;
const zipPath = outputPath(`${base}.zip`);
const tmpPath = outputPath(`${base}.zip.tmp`);
const sumPath = outputPath(`${base}.zip.sha256`);
const reportPath = outputPath(`${base}.report.json`);

await mkdir(OUT_DIR, { recursive: true });
for (const path of [zipPath, tmpPath, sumPath, reportPath]) await rm(path, { force: true });

// 1. Fresh production build (Vite empties dist/ first).
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
const build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: ROOT, stdio: 'inherit' });
if (build.status !== 0) throw new Error(`vite build failed (exit ${String(build.status)})`);

// 2. Explicit production-file selection, verified before zipping.
const files = await collectProductionFiles(DIST);
verifyExtensionFiles(files, pkg.version);

// 3. Write, read back the real archive from disk, verify, then publish locally.
await writeFile(tmpPath, createZip([...files].map(([name, data]) => ({ name, data }))));
const written = await readFile(tmpPath);
const verified = verifyArchive(written, files, pkg.version);
await rename(tmpPath, zipPath);

const digest = sha256(written);
await writeFile(sumPath, `${digest}  ${base}.zip\n`);
const head = git(['rev-parse', 'HEAD']);
const report = {
  package: `${base}.zip`,
  version: verified.version,
  extensionName: verified.name,
  sha256: digest,
  bytes: written.length,
  sourceCommit: process.env.BETA_SOURCE_COMMIT || head,
  checkoutCommit: head,
  workingTreeClean: head === null ? null : git(['status', '--porcelain']) === '',
  node: process.version,
  permissions: verified.permissions,
  icons: verified.icons,
  files: verified.files.map((name) => {
    const data = files.get(name) as Buffer;
    return { path: name, bytes: data.length, sha256: sha256(data) };
  }),
  note: 'Local beta build artifact for manual testing. Not a Chrome Web Store submission or public release.',
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`\nBeta package verified (${verified.files.length} files, permissions: ${verified.permissions.join(', ')})`);
for (const path of [zipPath, sumPath, reportPath]) console.log(`  ${path.slice(ROOT.length + 1).split(sep).join('/')}`);
console.log(`  sha256 ${digest}`);
