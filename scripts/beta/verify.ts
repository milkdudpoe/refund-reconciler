// Production-file selection and archive verification for the beta package.
//
// The packager never zips a directory wholesale. It walks the build output,
// accepts only regular files whose paths match the production allowlist, and
// keeps exactly the files reachable from manifest.json (pages, the service
// worker, icons, and the scripts, styles and chunks they load). Then it reads
// the archive actually written to disk back and checks it file by file against
// that selection, so a stale, partial or unexpected archive fails packaging.

import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { readPngSize } from './png.ts';
import { isRegularFileEntry, isSafeEntryName, readZip } from './zip.ts';

/** The only permissions the production extension may request, in order. */
export const PRODUCTION_PERMISSIONS = ['storage', 'activeTab', 'scripting'] as const;
export const ICON_SIZES = [16, 32, 48, 128] as const;
export const DESCRIPTION_MAX = 132;

/** Paths a production build may contain. Anything else in the build output fails packaging. */
const ALLOWED_PATHS: readonly RegExp[] = [
  /^manifest\.json$/,
  /^(dashboard|popup)\.html$/,
  /^(dashboard|popup|background)\.js$/,
  /^chunks\/[A-Za-z0-9_-]+\.js$/,
  /^assets\/[A-Za-z0-9_-]+\.css$/,
  /^icons\/icon-(16|32|48|128)\.png$/,
];

const ALLOWED_MANIFEST_KEYS = new Set([
  'manifest_version',
  'name',
  'short_name',
  'version',
  'description',
  'minimum_chrome_version',
  'icons',
  'permissions',
  'background',
  'action',
  'content_security_policy',
]);

/** Extension pages opened with chrome.runtime.getURL rather than named in the manifest. */
const OPENED_BY_URL = ['dashboard.html'];

/** Strings that only appear in browser-test scaffolding; none may reach the package. */
const TEST_ONLY_MARKERS = ['TEST COPY', 'evil.example', '000-SYNTHETIC', 'sourceMappingURL', '__pwned'];

export type FileMap = ReadonlyMap<string, Buffer>;

export interface VerifiedExtension {
  version: string;
  name: string;
  description: string;
  permissions: string[];
  icons: Record<string, string>;
  files: string[];
}

class PackageError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PackageError(message);
}

export function isAllowedProductionPath(name: string): boolean {
  return isSafeEntryName(name) && ALLOWED_PATHS.some((re) => re.test(name));
}

/** Resolves `ref` (as written in `fromFile`) to an archive path, or null for an external/non-file reference. */
function resolveLocal(fromFile: string, ref: string): string | null {
  if (/^(data:|#)/.test(ref)) return null;
  check(!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref), `${fromFile} references a non-local URL: ${ref}`);
  const clean = ref.split(/[?#]/)[0] ?? '';
  const base = clean.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      check(base.length > 0, `${fromFile} references a path outside the package: ${ref}`);
      base.pop();
    } else base.push(seg);
  }
  return base.join('/');
}

function referencesIn(name: string, text: string): string[] {
  const refs: string[] = [];
  const collect = (re: RegExp) => {
    for (const m of text.matchAll(re)) if (m[1] !== undefined) refs.push(m[1]);
  };
  if (name.endsWith('.html')) {
    collect(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
    collect(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi);
    collect(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  } else if (name.endsWith('.js')) {
    collect(/\b(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["'](\.{1,2}\/[^"']+)["']/g);
    collect(/\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g);
  } else if (name.endsWith('.css')) {
    collect(/url\(\s*["']?([^"')]+)["']?\s*\)/g);
    collect(/@import\s+["']([^"']+)["']/g);
  }
  return refs;
}

/**
 * Checks a complete set of extension files (from the build or from the
 * archive): manifest identity, version, description length, exact
 * permissions, icons, and that every local reference resolves and every file
 * is referenced.
 */
export function verifyExtensionFiles(files: FileMap, expectedVersion: string): VerifiedExtension {
  for (const name of files.keys()) check(isAllowedProductionPath(name), `Unexpected file in package: ${name}`);
  const manifestBytes = files.get('manifest.json');
  check(manifestBytes, 'manifest.json is missing from the package root');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new PackageError('manifest.json is not valid JSON');
  }
  for (const key of Object.keys(manifest)) check(ALLOWED_MANIFEST_KEYS.has(key), `Unexpected manifest key: ${key}`);
  check(manifest.manifest_version === 3, 'manifest_version must be 3');
  check(manifest.version === expectedVersion, `manifest version ${String(manifest.version)} does not match package version ${expectedVersion}`);
  const name = manifest.name;
  check(typeof name === 'string' && name.startsWith('Refund Reconciler'), 'manifest name must keep the Refund Reconciler identity');
  check(/preview|beta/i.test(name), 'manifest name must keep its preview/beta positioning');
  const description = manifest.description;
  check(typeof description === 'string' && description.length > 0, 'manifest description is missing');
  check(description.length <= DESCRIPTION_MAX, `manifest description is ${description.length} characters (max ${DESCRIPTION_MAX})`);
  check(
    JSON.stringify(manifest.permissions) === JSON.stringify(PRODUCTION_PERMISSIONS),
    `permissions must be exactly ${PRODUCTION_PERMISSIONS.join(', ')}; found ${JSON.stringify(manifest.permissions)}`,
  );

  // dashboard.html is not named in the manifest: the popup opens it by URL.
  const roots: string[] = ['manifest.json', ...OPENED_BY_URL];
  const background = manifest.background as { service_worker?: unknown; type?: unknown } | undefined;
  check(typeof background?.service_worker === 'string', 'background.service_worker is missing');
  check(background.type === 'module', 'background service worker must be a module');
  roots.push(background.service_worker);
  const action = manifest.action as { default_popup?: unknown; default_icon?: unknown } | undefined;
  check(typeof action?.default_popup === 'string', 'action.default_popup is missing');
  roots.push(action.default_popup);

  const icons = manifest.icons as Record<string, unknown> | undefined;
  check(icons && typeof icons === 'object', 'manifest icons are missing');
  check(
    JSON.stringify(Object.keys(icons).map(Number)) === JSON.stringify(ICON_SIZES),
    `manifest icons must be exactly ${ICON_SIZES.join(', ')}`,
  );
  const iconPaths: [number, unknown][] = Object.entries(icons).map(([size, path]) => [Number(size), path]);
  const actionIcon = action.default_icon as Record<string, unknown> | undefined;
  check(actionIcon && typeof actionIcon === 'object' && Object.keys(actionIcon).length > 0, 'action.default_icon is missing');
  iconPaths.push(...Object.entries(actionIcon).map(([size, path]): [number, unknown] => [Number(size), path]));
  for (const [size, path] of iconPaths) {
    check(typeof path === 'string' && path.endsWith('.png'), `icon ${size} must be a PNG path`);
    const png = files.get(path);
    check(png, `icon ${size} (${path}) is missing`);
    const actual = readPngSize(png);
    check(actual.width === size && actual.height === size, `${path} is ${actual.width}x${actual.height}, expected ${size}x${size}`);
    roots.push(path);
  }

  // Reachability: every reference must exist, and every file must be reachable.
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.has(file)) continue;
    const bytes = files.get(file);
    check(bytes, `Referenced file is missing from the package: ${file}`);
    reached.add(file);
    if (file.endsWith('.png') || file === 'manifest.json') continue;
    for (const ref of referencesIn(file, bytes.toString('utf8'))) {
      const target = resolveLocal(file, ref);
      if (target !== null) queue.push(target);
    }
  }
  for (const file of files.keys()) check(reached.has(file), `File is not referenced by the extension: ${file}`);
  for (const page of OPENED_BY_URL) {
    const opener = [...files].some(([f, b]) => f.endsWith('.js') && b.toString('utf8').includes(`getURL(\`${page}`));
    check(opener, `No script opens ${page}; it would be unreachable`);
  }

  for (const [file, bytes] of files) {
    if (file.endsWith('.png')) continue;
    const text = bytes.toString('utf8');
    for (const marker of TEST_ONLY_MARKERS) check(!text.includes(marker), `${file} contains test-only text: ${marker}`);
  }

  return {
    version: manifest.version as string,
    name,
    description,
    permissions: [...PRODUCTION_PERMISSIONS],
    icons: Object.fromEntries(Object.entries(icons).map(([k, v]) => [k, String(v)])),
    files: [...files.keys()].sort(),
  };
}

/**
 * Selects the production files from a build directory. Symlinks, special files
 * and paths outside the allowlist fail rather than being skipped, so nothing
 * unexpected can be included by accident.
 */
export async function collectProductionFiles(buildDir: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(buildDir, full).split(sep).join('/');
      const info = await lstat(full);
      check(!info.isSymbolicLink(), `Refusing symlink in build output: ${rel}`);
      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      check(info.isFile(), `Refusing non-regular file in build output: ${rel}`);
      check(isAllowedProductionPath(rel), `Unexpected file in build output: ${rel}`);
      found.set(rel, await readFile(full));
    }
  }
  await walk(buildDir);
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Reads an archive's bytes and checks that it is exactly `expected`: safe
 * relative regular-file entries, no directories, symlinks or duplicates, the
 * same set of paths, identical contents, and a valid extension.
 */
export function verifyArchive(zip: Uint8Array, expected: FileMap, expectedVersion: string): VerifiedExtension {
  const entries = readZip(zip);
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    check(isSafeEntryName(entry.name), `Unsafe path in archive: ${JSON.stringify(entry.name)}`);
    check(isRegularFileEntry(entry), `Archive entry is not a regular file: ${entry.name}`);
    check(!files.has(entry.name), `Duplicate path in archive: ${entry.name}`);
    files.set(entry.name, entry.data);
  }
  for (const name of expected.keys()) check(files.has(name), `Archive is missing ${name}`);
  for (const [name, data] of files) {
    const want = expected.get(name);
    check(want, `Archive contains a file that is not in the build: ${name}`);
    check(want.equals(data), `Archive copy of ${name} differs from the build`);
  }
  return verifyExtensionFiles(files, expectedVersion);
}

export { PackageError };
