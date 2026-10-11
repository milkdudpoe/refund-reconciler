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
//   npm run site:publication-check
//                           site:check plus the publication requirements
//                           (effective date, no draft notes, banners or
//                           [PENDING] markers, confirmed host); refuses the
//                           draft prepared for review (changes nothing)
//
// Writes only the named files above; the artifact directory is git-ignored.
// Nothing here publishes, deploys or contacts any service; deployment is the
// separate, manually run .github/workflows/publisher-site-pages.yml.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SITE_DIR, SITE_FILES } from './site/checks.ts';
import { checkPublication } from './site/publication.ts';
import { checkSiteSources, POLICY_MD, writeDerivedFiles } from './site/sources.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'artifacts', 'publisher-site');

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

function git(args: string[]): string | null {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
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
  await writeDerivedFiles(ROOT, console.log);
} else if (mode === '--check' || mode === '--artifact') {
  const problems = await checkSiteSources(ROOT);
  if (problems.length > 0) {
    for (const p of problems) console.error(`publisher site: ${p}`);
    process.exit(1);
  }
  console.log(`publisher site: ${SITE_FILES.length} files checked, policy copies up to date`);
  if (mode === '--artifact') await artifact();
} else if (mode === '--publication-check') {
  const problems = await checkPublication(ROOT);
  if (problems.length > 0) {
    for (const p of problems) console.error(`publication gate: ${p}`);
    console.error(`publication gate: REFUSED (${problems.length} problems). The site is not ready to publish; see docs/store/publisher-site.md.`);
    process.exit(1);
  }
  console.log(`publication gate: passed (${SITE_FILES.length} files, policy finalized). This is a check of files, not a deployment.`);
} else {
  console.error('usage: publisher-site.ts [--write | --check | --artifact | --publication-check]');
  process.exit(2);
}
