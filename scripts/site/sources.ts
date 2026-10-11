// The derived files of the publisher site and their staleness check: both policy
// HTML forms are rendered from docs/store/privacy-policy.md, and the site images
// are byte copies of reviewed repository files. Shared by
// scripts/publisher-site.ts (site:policy, site:check, site:artifact,
// site:publication-check) and the unit tests, which run them on fixture copies.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkSite, SITE_ASSET_SOURCES, SITE_DIR } from './checks.ts';
import { injectPolicy, renderPolicy, standalonePolicyHtml } from './policy.ts';

export const POLICY_MD = 'docs/store/privacy-policy.md';
export const POLICY_HTML = 'docs/store/privacy-policy.html';
export const SITE_PRIVACY = `${SITE_DIR}/privacy.html`;

export const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/** The generated text files and their expected contents. */
export async function expectedPolicyFiles(root: string): Promise<Map<string, string>> {
  const policy = renderPolicy(await readFile(join(root, POLICY_MD), 'utf8'));
  const sitePage = await readFile(join(root, SITE_PRIVACY), 'utf8');
  return new Map([
    [POLICY_HTML, standalonePolicyHtml(policy)],
    [SITE_PRIVACY, injectPolicy(sitePage, policy)],
  ]);
}

/** Regenerates both policy HTML forms and refreshes the copied images (site:policy). */
export async function writeDerivedFiles(root: string, log: (line: string) => void = () => {}): Promise<void> {
  for (const [file, text] of await expectedPolicyFiles(root)) {
    await writeFile(join(root, file), text);
    log(`wrote ${file}`);
  }
  for (const [file, source] of Object.entries(SITE_ASSET_SOURCES)) {
    await mkdir(dirname(join(root, SITE_DIR, file)), { recursive: true });
    await copyFile(join(root, source), join(root, SITE_DIR, file));
    log(`copied ${source} -> ${SITE_DIR}/${file}`);
  }
}

/**
 * The ordinary site check (site:check): derived files up to date, then the
 * static checks of the site folder. Reads only. Also accepts a draft site.
 */
export async function checkSiteSources(root: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [file, text] of await expectedPolicyFiles(root)) {
    if (lf(await readFile(join(root, file), 'utf8')) !== text) problems.push(`${file} is out of date with ${POLICY_MD}; run npm run site:policy`);
  }
  for (const [file, source] of Object.entries(SITE_ASSET_SOURCES)) {
    const [copy, original] = await Promise.all([readFile(join(root, SITE_DIR, file)).catch(() => null), readFile(join(root, source))]);
    if (copy === null || !copy.equals(original)) problems.push(`${SITE_DIR}/${file} differs from ${source}; run npm run site:policy`);
  }
  problems.push(...(await checkSite(root)));
  return problems;
}
