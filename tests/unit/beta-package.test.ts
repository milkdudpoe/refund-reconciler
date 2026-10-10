// Beta packaging: production-file selection, archive writing/reading and the
// checks that make a stale, incomplete or unsafe archive fail. The fixture
// extension uses the real public/manifest.json and real icons with small stub
// pages and scripts, so manifest and icon changes are checked here too.

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPngSize } from '../../scripts/beta/png.ts';
import { DESCRIPTION_MAX, collectProductionFiles, verifyArchive, verifyExtensionFiles } from '../../scripts/beta/verify.ts';
import { createZip, isSafeEntryName, readZip } from '../../scripts/beta/zip.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const VERSION = (JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const MANIFEST = await readFile(join(ROOT, 'public', 'manifest.json'));
const ICONS = Object.fromEntries(
  await Promise.all([16, 32, 48, 128].map(async (n) => [`icons/icon-${n}.png`, await readFile(join(ROOT, 'public', 'icons', `icon-${n}.png`))] as const)),
);

function fixture(overrides: Record<string, string | Buffer | null> = {}): Map<string, Buffer> {
  const files = new Map<string, string | Buffer>(Object.entries({
    'manifest.json': MANIFEST,
    ...ICONS,
    'popup.html': '<!doctype html><script type="module" crossorigin src="./popup.js"></script><link rel="stylesheet" href="./assets/styles-a1.css">',
    'dashboard.html': '<!doctype html><script type="module" crossorigin src="./dashboard.js"></script><link rel="stylesheet" href="./assets/styles-a1.css">',
    'popup.js': 'import { s } from "./chunks/storage-b2.js";\nchrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${h}`) });',
    'dashboard.js': 'import "./chunks/storage-b2.js";',
    'background.js': 'import { s } from "./chunks/storage-b2.js";',
    'chunks/storage-b2.js': 'export const s = 1;',
    'assets/styles-a1.css': 'body { color: red; }',
  }));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) files.delete(name);
    else files.set(name, value);
  }
  return new Map([...files].map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v)]));
}

function manifestWith(change: (m: Record<string, unknown>) => void): string {
  const m = JSON.parse(MANIFEST.toString('utf8')) as Record<string, unknown>;
  change(m);
  return JSON.stringify(m);
}

const zipOf = (files: Map<string, Buffer>) => createZip([...files].map(([name, data]) => ({ name, data })));

/** Rewrites an entry name in both the local and central headers (same byte length). */
function renameInArchive(zip: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  for (let i = out.indexOf(needle); i >= 0; i = out.indexOf(needle, i + 1)) Buffer.from(to).copy(out, i);
  return out;
}

/** Sets the Unix mode recorded for `name` in the central directory. */
function setUnixMode(zip: Buffer, name: string, mode: number): Buffer {
  const out = Buffer.from(zip);
  for (let p = 0; p < out.length - 46; p++) {
    if (out.readUInt32LE(p) !== 0x02014b50) continue;
    const len = out.readUInt16LE(p + 28);
    if (out.toString('utf8', p + 46, p + 46 + len) === name) out.writeUInt32LE((mode << 16) >>> 0, p + 38);
  }
  return out;
}

describe('the shipped manifest and icons', () => {
  it('keep the identity, a short accurate description, exact permissions and correctly sized PNG icons', () => {
    const m = JSON.parse(MANIFEST.toString('utf8'));
    expect(m.version).toBe(VERSION);
    expect(m.name).toBe('Refund Reconciler (local preview)');
    expect(m.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(m.description).toMatch(/manually/i);
    expect(m.description).not.toMatch(/automatic|verified|guarantee|recover/i);
    expect(m.permissions).toEqual(['storage', 'activeTab', 'scripting']);
    for (const [size, path] of Object.entries({ ...m.icons, ...m.action.default_icon }) as [string, string][]) {
      const png = ICONS[path];
      expect(png, path).toBeDefined();
      expect(readPngSize(png!)).toEqual({ width: Number(size), height: Number(size) });
    }
  });
});

describe('archive writer and reader', () => {
  it('round-trips files byte for byte and is reproducible', () => {
    const files = fixture();
    const zip = zipOf(files);
    expect(zipOf(fixture()).equals(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual([...files.keys()]);
    for (const e of entries) expect(e.data.equals(files.get(e.name)!)).toBe(true);
    expect(verifyArchive(zip, files, VERSION).files).toEqual([...files.keys()].sort());
  });

  it('accepts only plain relative entry names', () => {
    for (const ok of ['manifest.json', 'chunks/a-b_c.js', 'icons/icon-16.png']) expect(isSafeEntryName(ok)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x.js', 'a/../../x', 'a//b', './a', 'C:/x', 'a\\b', 'a\u0000b', 'dir/', 'con.']) {
      expect(isSafeEntryName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(() => createZip([{ name: '../evil.js', data: Buffer.from('x') }])).toThrow(/Unsafe archive path/);
    expect(() => createZip([{ name: 'a.js', data: Buffer.alloc(0) }, { name: 'a.js', data: Buffer.alloc(0) }])).toThrow(/Duplicate/);
  });

  it('rejects truncated or corrupted archives', () => {
    const zip = zipOf(fixture());
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow(/Invalid archive/);
    const flipped = Buffer.from(zip);
    flipped[40] = flipped[40]! ^ 0xff; // inside the first entry's compressed data
    expect(() => readZip(flipped)).toThrow(/Invalid archive|invalid|incorrect/);
  });
});

describe('archive verification', () => {
  const expectRejected = (zip: Buffer, files: Map<string, Buffer>, message: RegExp) => expect(() => verifyArchive(zip, files, VERSION)).toThrow(message);

  it('rejects path traversal, symlink and directory entries read from the archive', () => {
    const files = fixture({ 'chunks/zz-zz.js': 'x' });
    const zip = zipOf(files);
    expectRejected(renameInArchive(zip, 'chunks/zz-zz.js', '../../../aaa.js'), files, /Unsafe path/);
    expectRejected(renameInArchive(zip, 'chunks/zz-zz.js', '/hunks/zz-zz.js'), files, /Unsafe path/);
    expectRejected(setUnixMode(zip, 'popup.js', 0o120777), files, /not a regular file/);
    expectRejected(setUnixMode(zip, 'popup.js', 0o040755), files, /not a regular file/);
  });

  it('fails a stale, incomplete or padded archive', () => {
    const files = fixture();
    const zip = zipOf(files);
    expectRejected(zip, fixture({ 'popup.js': `${files.get('popup.js')!.toString()}\n// rebuilt` }), /differs from the build/);
    expectRejected(zipOf(fixture({ 'dashboard.js': null })), files, /missing dashboard\.js/);
    expectRejected(zipOf(fixture({ 'chunks/extra.js': 'x' })), files, /not in the build/);
  });

  it('requires every referenced file to exist and every file to be referenced', () => {
    expect(() => verifyExtensionFiles(fixture({ 'chunks/storage-b2.js': null }), VERSION)).toThrow(/Referenced file is missing.*storage-b2/);
    expect(() => verifyExtensionFiles(fixture({ 'assets/styles-a1.css': null }), VERSION)).toThrow(/styles-a1\.css/);
    expect(() => verifyExtensionFiles(fixture({ 'chunks/orphan.js': 'x' }), VERSION)).toThrow(/not referenced.*orphan/);
    expect(() => verifyExtensionFiles(fixture({ 'popup.js': 'import "./chunks/storage-b2.js";' }), VERSION)).toThrow(/No script opens dashboard\.html/);
    expect(() => verifyExtensionFiles(fixture({ 'popup.html': '<script src="https://cdn.example/x.js"></script>' }), VERSION)).toThrow(/non-local URL/);
    expect(() => verifyExtensionFiles(fixture({ '.env': 'SECRET=1' }), VERSION)).toThrow(/Unexpected file in package: \.env/);
  });

  it('enforces production permissions, manifest keys, version, description length and test-only markers', () => {
    const bad = (change: (m: Record<string, unknown>) => void) => fixture({ 'manifest.json': manifestWith(change) });
    expect(() => verifyExtensionFiles(bad((m) => (m.permissions = ['storage', 'activeTab', 'scripting', 'tabs'])), VERSION)).toThrow(/permissions must be exactly/);
    expect(() => verifyExtensionFiles(bad((m) => (m.host_permissions = ['https://www.amazon.com/*'])), VERSION)).toThrow(/Unexpected manifest key: host_permissions/);
    expect(() => verifyExtensionFiles(bad((m) => (m.content_scripts = [])), VERSION)).toThrow(/Unexpected manifest key: content_scripts/);
    expect(() => verifyExtensionFiles(bad((m) => (m.version = '0.5.0')), VERSION)).toThrow(/does not match package version/);
    expect(() => verifyExtensionFiles(bad((m) => (m.description = 'x'.repeat(133))), VERSION)).toThrow(/133 characters \(max 132\)/);
    expect(() => verifyExtensionFiles(bad((m) => (m.name = 'Refund Reconciler')), VERSION)).toThrow(/preview\/beta positioning/);
    expect(() => verifyExtensionFiles(bad((m) => (m.name = `${String(m.name)} [TEST COPY — fixture hosts only]`)), VERSION)).toThrow(/test-only text: TEST COPY/);
    expect(() => verifyExtensionFiles(fixture({ 'popup.js': `${fixture().get('popup.js')!.toString()}\n//# sourceMappingURL=popup.js.map` }), VERSION)).toThrow(/sourceMappingURL/);
  });

  it('checks icon paths and pixel sizes', () => {
    expect(() => verifyExtensionFiles(fixture({ 'icons/icon-16.png': ICONS['icons/icon-32.png']! }), VERSION)).toThrow(/icon-16\.png is 32x32, expected 16x16/);
    expect(() => verifyExtensionFiles(fixture({ 'icons/icon-48.png': null }), VERSION)).toThrow(/icon 48 .* is missing/);
    expect(() => verifyExtensionFiles(fixture({ 'icons/icon-128.png': 'not a png' }), VERSION)).toThrow(/not a PNG/);
  });
});

describe('production-file selection from a build directory', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function buildDir(files: Map<string, Buffer>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'refund-reconciler-pkg-test-'));
    for (const [name, data] of files) {
      await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(dir, ...name.split('/')), data);
    }
    return dir;
  }

  it('selects exactly the allowed production files, sorted', async () => {
    const files = fixture();
    const selected = await collectProductionFiles(await buildDir(files));
    expect([...selected.keys()]).toEqual([...files.keys()].sort());
  });

  it('refuses unexpected files instead of skipping them', async () => {
    const d = await buildDir(fixture());
    await writeFile(join(d, 'debug.log'), 'x');
    await expect(collectProductionFiles(d)).rejects.toThrow(/Unexpected file in build output: debug\.log/);
    await rm(join(d, 'debug.log'));
    await mkdir(join(d, '.git'));
    await writeFile(join(d, '.git', 'config'), 'x');
    await expect(collectProductionFiles(d)).rejects.toThrow(/Unexpected file in build output: \.git\/config/);
  });

  // Creating symlinks needs extra privileges on Windows.
  it.skipIf(process.platform === 'win32')('refuses symlinks', async () => {
    const d = await buildDir(fixture());
    await symlink(join(ROOT, 'package.json'), join(d, 'chunks', 'linked.js'));
    await expect(collectProductionFiles(d)).rejects.toThrow(/Refusing symlink in build output: chunks\/linked\.js/);
  });
});
