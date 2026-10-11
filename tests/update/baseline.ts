// Builds earlier production versions from their actual source at immutable
// commits, for the same-installation update check (`npm run test:update`):
// 0.5.0 (merged Task 05), 0.6.0 (Task 07.1, the last plaintext version) and
// 0.7.0 (Task 09.1, the first encrypted version, before the consent gate).
//
// Everything is written inside one directory the caller created for this
// check. The repository is only read: `git archive` exports the commit's tree
// without touching the working tree, index, HEAD or any other checkout. The
// commit must already be in the local object store; CI fetches it explicitly
// (see .github/workflows/ci.yml), and a full clone of this repository has it.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { isSafeEntryName, readZip } from '../../scripts/beta/zip.ts';

export interface Baseline {
  readonly commit: string;
  readonly version: string;
  readonly label: string;
}

/** b323930: merge of PR #5 (Task 05), the last production version before the beta. */
export const BASELINE_050: Baseline = { commit: 'b323930f7d9580f426e7e8fee39b4242143c4844', version: '0.5.0', label: 'Task 05' };
/** 60e330b: Task 07.1 head (merged in PR #7), the last version that stored the ledger in plaintext. */
export const BASELINE_060: Baseline = { commit: '60e330b12d195908a44ad341a73e34678a5a697d', version: '0.6.0', label: 'Task 07.1' };
/** da47584: reviewed Task 09.1 head (merged in PR #9), the encrypted ledger without the data-practices agreement. */
export const BASELINE_070: Baseline = { commit: 'da475840933b21eab85553e8b2ad54c3e049bf90', version: '0.7.0', label: 'Task 09.1' };
export const BASELINES: readonly Baseline[] = [BASELINE_050, BASELINE_060, BASELINE_070];

export function fetchHint(b: Baseline): string {
  return `git fetch --no-tags --depth=1 origin ${b.commit}`;
}

const ROOT = resolve(import.meta.dirname, '../..');

function run(cmd: string, args: string[], cwd: string, opts: { capture?: boolean } = {}): Buffer {
  const r = spawnSync(cmd, args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${String(r.status)})${opts.capture ? `: ${r.stderr.toString()}` : ''}`);
  return r.stdout ?? Buffer.alloc(0);
}

/**
 * Exports the baseline commit's tree into `<work>/baseline-<version>-src`. Line
 * endings are pinned to the committed (LF) bytes regardless of local autocrlf
 * settings.
 */
export async function exportBaselineSource(work: string, b: Baseline): Promise<string> {
  const present = spawnSync('git', ['cat-file', '-e', `${b.commit}^{commit}`], { cwd: ROOT });
  if (present.status !== 0) {
    throw new Error(`Baseline commit ${b.commit} (${b.version}) is not in the local repository. Fetch it first:\n  ${fetchHint(b)}`);
  }
  // Only regular files: no symlinks or submodules in the exported tree.
  const modes = run('git', ['ls-tree', '-r', '--format=%(objectmode)', b.commit], ROOT, { capture: true }).toString().trim().split('\n');
  if (modes.some((m) => m !== '100644' && m !== '100755')) throw new Error(`Baseline tree has non-regular entries: ${[...new Set(modes)].join(', ')}`);

  const archive = run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', b.commit], ROOT, { capture: true });
  const src = join(work, `baseline-${b.version}-src`);
  let files = 0;
  for (const entry of readZip(archive)) {
    if (entry.isDirectory) continue;
    if (!isSafeEntryName(entry.name)) throw new Error(`Unsafe path in baseline archive: ${entry.name}`);
    const target = resolve(src, ...entry.name.split('/'));
    if (!target.startsWith(src + sep)) throw new Error(`Baseline path escapes its folder: ${entry.name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    files += 1;
  }
  if (files !== modes.length) throw new Error(`Exported ${files} files, but the commit has ${modes.length}`);
  return src;
}

/**
 * Installs the baseline's own pinned dependencies (`npm ci` from its own
 * lockfile, lifecycle scripts disabled) and runs its own production build.
 * Returns the built extension folder.
 */
export async function buildBaseline(src: string, b: Baseline): Promise<string> {
  const pkg = JSON.parse(await readFile(join(src, 'package.json'), 'utf8')) as { version: string };
  const manifest = JSON.parse(await readFile(join(src, 'public', 'manifest.json'), 'utf8')) as { version: string };
  if (pkg.version !== b.version || manifest.version !== b.version) {
    throw new Error(`Baseline source is ${pkg.version}/${manifest.version}, expected ${b.version}`);
  }
  // Run npm through the same Node/npm that runs this check (works on Windows without a shell).
  const npmCli = process.env.npm_execpath;
  const npm = npmCli && /npm-cli\.js$/.test(npmCli) ? { cmd: process.execPath, pre: [npmCli] } : { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', pre: [] };
  run(npm.cmd, [...npm.pre, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], src);
  run(process.execPath, [join(src, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], src);
  const dist = join(src, 'dist');
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Baseline build produced no dist/manifest.json');
  const built = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8')) as { version: string };
  if (built.version !== b.version) throw new Error(`Baseline build is ${built.version}, expected ${b.version}`);
  return dist;
}
