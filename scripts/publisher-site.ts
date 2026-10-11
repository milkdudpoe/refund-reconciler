// The publisher site (publisher-site/) and its policy copies. See
// docs/store/publisher-site.md.
//
//   npm run site:policy     regenerate docs/store/privacy-policy.html and the
//                           policy region of publisher-site/privacy.html from
//                           docs/store/privacy-policy.md, and refresh the copied
//                           images from their sources
//   npm run site:check      fail if any of those are out of date, or if the site
//                           has unexpected files, scripts, forms or external
//                           resources (changes nothing)
//   npm run site:artifact   site:check, then stage exactly the site files in
//                           artifacts/publisher-site/site/ with a provenance
//                           report beside them (not inside the site)
//
// Writes only the named files above; the artifact directory is git-ignored.
// Nothing here publishes, deploys or contacts any service.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { checkSite, SITE_ASSET_SOURCES, SITE_DIR, SITE_FILES } from './site/checks.ts';
import { injectPolicy, renderPolicy, standalonePolicyHtml } from './site/policy.ts';

const ROOT = resolve(import.meta.dirname, '..');
const POLICY_MD = 'docs/store/privacy-policy.md';
const POLICY_HTML = 'docs/store/privacy-policy.html';
const SITE_PRIVACY = `${SITE_DIR}/privacy.html`;
const OUT_DIR = join(ROOT, 'artifacts', 'publisher-site');

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The generated text files and their expected contents. */
async function expectedPolicyFiles(): Promise<Map<string, string>> {
  const policy = renderPolicy(await readFile(join(ROOT, POLICY_MD), 'utf8'));
  const sitePage = await readFile(join(ROOT, SITE_PRIVACY), 'utf8');
  return new Map([
    [POLICY_HTML, standalonePolicyHtml(policy)],
    [SITE_PRIVACY, injectPolicy(sitePage, policy)],
  ]);
}

async function write(): Promise<void> {
  for (const [file, text] of await expectedPolicyFiles()) {
    await writeFile(join(ROOT, file), text);
    console.log(`wrote ${file}`);
  }
  for (const [file, source] of Object.entries(SITE_ASSET_SOURCES)) {
    await mkdir(dirname(join(ROOT, SITE_DIR, file)), { recursive: true });
    await copyFile(join(ROOT, source), join(ROOT, SITE_DIR, file));
    console.log(`copied ${source} -> ${SITE_DIR}/${file}`);
  }
}

async function check(): Promise<string[]> {
  const problems: string[] = [];
  for (const [file, text] of await expectedPolicyFiles()) {
    if (lf(await readFile(join(ROOT, file), 'utf8')) !== text) problems.push(`${file} is out of date with ${POLICY_MD}; run npm run site:policy`);
  }
  for (const [file, source] of Object.entries(SITE_ASSET_SOURCES)) {
    const [copy, original] = await Promise.all([readFile(join(ROOT, SITE_DIR, file)).catch(() => null), readFile(join(ROOT, source))]);
    if (copy === null || !copy.equals(original)) problems.push(`${SITE_DIR}/${file} differs from ${source}; run npm run site:policy`);
  }
  problems.push(...(await checkSite(ROOT)));
  return problems;
}

async function artifact(): Promise<void> {
  const siteOut = join(OUT_DIR, 'site');
  await rm(siteOut, { recursive: true, force: true });
  const files = [];
  for (const file of SITE_FILES) {
    const data = await readFile(join(ROOT, SITE_DIR, file));
    await mkdir(dirname(join(siteOut, file)), { recursive: true });
    await writeFile(join(siteOut, file), data);
    files.push({ path: file, bytes: data.length, sha256: sha256(data) });
  }
  const head = git(['rev-parse', 'HEAD']);
  const dirty = head === null ? [] : (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean);
  const ci = process.env.GITHUB_ACTIONS === 'true' && !!process.env.BETA_SOURCE_COMMIT;
  const policySource = await readFile(join(ROOT, POLICY_MD));
  const report = {
    kind: 'refund-reconciler-publisher-site',
    generation: ci ? 'ci-final-head' : 'local',
    note: 'Static files prepared for review. Not hosted, deployed or published. This report is not part of the site.',
    sourceCommit: process.env.BETA_SOURCE_COMMIT || head,
    checkoutCommit: head,
    workingTreeClean: head === null ? null : dirty.length === 0,
    dirtyPaths: dirty,
    policySource: { path: POLICY_MD, bytes: policySource.length, sha256: sha256(policySource) },
    siteDirectory: 'site/',
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  };
  await writeFile(join(OUT_DIR, 'publisher-site-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

const mode = process.argv[2] ?? '--write';
if (mode === '--write') {
  await write();
} else if (mode === '--check' || mode === '--artifact') {
  const problems = await check();
  if (problems.length > 0) {
    for (const p of problems) console.error(`publisher site: ${p}`);
    process.exit(1);
  }
  console.log(`publisher site: ${SITE_FILES.length} files checked, policy copies up to date`);
  if (mode === '--artifact') await artifact();
} else {
  console.error('usage: publisher-site.ts [--write | --check | --artifact]');
  process.exit(2);
}
