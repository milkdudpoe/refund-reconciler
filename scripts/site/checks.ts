// Inventory and static checks for the publisher site (publisher-site/). Used by
// `npm run site:check`, `npm run site:artifact` and tests/unit/publisher-site.test.ts.

import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

export const PUBLISHER = 'MJUD';
export const CONTACT_EMAIL = 'exiledeals@gmail.com';

export const SITE_DIR = 'publisher-site';
export const PAGES = ['index.html', 'privacy.html', 'support.html'] as const;

/** Site images that are byte-for-byte copies of reviewed repository files. */
export const SITE_ASSET_SOURCES: Readonly<Record<string, string>> = {
  'assets/icon-32.png': 'public/icons/icon-32.png',
  'assets/icon-128.png': 'public/icons/icon-128.png',
  'assets/example-item-evidence.png': 'store-assets/screenshot-2-item-evidence-1280x800.png',
};

/** Every file the site consists of. Anything else in publisher-site/ is an error. */
export const SITE_FILES: readonly string[] = [...PAGES, 'styles.css', ...Object.keys(SITE_ASSET_SOURCES)].sort();

export async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`${SITE_DIR}/${rel} is not a regular file`);
  }
  return out.sort();
}

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));
}

/**
 * Static checks of the site files: exact inventory, no scripts, forms, embeds,
 * inline handlers or external resources, relative links that resolve (with
 * their #fragments), and only the publisher's own mailto address.
 * Returns a list of problems (empty when the site passes).
 */
export async function checkSite(root: string): Promise<string[]> {
  const problems: string[] = [];
  const dir = join(root, SITE_DIR);
  const files = await listFiles(dir);
  if (files.join('\n') !== SITE_FILES.join('\n')) {
    problems.push(`site inventory differs: found [${files.join(', ')}], expected [${SITE_FILES.join(', ')}]`);
  }
  const pages = new Map<string, string>();
  for (const page of PAGES) pages.set(page, (await readFile(join(dir, page), 'utf8')).replace(/\r\n/g, '\n'));
  const css = await readFile(join(dir, 'styles.css'), 'utf8');

  if (/@import|url\(|@font-face/i.test(css)) problems.push('styles.css must not load fonts, images or other stylesheets');

  for (const [page, html] of pages) {
    const where = `${SITE_DIR}/${page}`;
    for (const [pattern, what] of [
      [/<script\b/i, 'a script'],
      [/<(form|input|button|textarea|select)\b/i, 'a form control'],
      [/<(iframe|embed|object|video|audio|canvas)\b/i, 'an embed'],
      [/\son[a-z]+\s*=/i, 'an inline event handler'],
      [/\sstyle\s*=/i, 'an inline style'],
      [/<base\b/i, 'a base URL'],
      [/<meta[^>]+http-equiv="refresh"/i, 'a refresh'],
      [/javascript:/i, 'a javascript: URL'],
    ] as const) {
      if (pattern.test(html)) problems.push(`${where} contains ${what}`);
    }
    if (!html.includes(PUBLISHER)) problems.push(`${where} does not name ${PUBLISHER}`);
    if (!html.includes(`href="mailto:${CONTACT_EMAIL}"`)) problems.push(`${where} has no mailto link to ${CONTACT_EMAIL}`);
    if (!/<html lang="en">/.test(html)) problems.push(`${where} must declare lang="en"`);
    if ((html.match(/<h1\b/g) ?? []).length !== 1) problems.push(`${where} must have exactly one h1`);
    if (!/<main id="main"/.test(html) || !/href="#main"/.test(html)) problems.push(`${where} needs a skip link to <main id="main">`);

    // Resources (src, link href) must be local files of the site.
    for (const m of html.matchAll(/<(img|link)\b[^>]*>/gi)) {
      const tag = m[0];
      const url = /\s(?:src|href)="([^"]*)"/.exec(tag)?.[1] ?? '';
      if (!SITE_FILES.includes(url)) problems.push(`${where} loads a resource that is not a local site file: ${url}`);
      if (/^<img/i.test(tag) && !/\salt="[^"]*"/.test(tag)) problems.push(`${where} has an image without an alt attribute: ${url}`);
    }
    // Anchors: local pages (with existing fragments), https references or the contact mailto.
    for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)) {
      const href = m[1] ?? '';
      if (href.startsWith('https://')) continue;
      if (href.startsWith('mailto:')) {
        if (href !== `mailto:${CONTACT_EMAIL}`) problems.push(`${where} has an unexpected mailto: ${href}`);
        continue;
      }
      const [path = '', fragment] = href.split('#');
      const target = path === '' ? page : posix.normalize(path);
      if (!pages.has(target)) {
        problems.push(`${where} links to ${href}, which is not a site page (links must be relative)`);
        continue;
      }
      if (fragment !== undefined && !idsIn(pages.get(target) ?? '').has(fragment)) problems.push(`${where} links to missing fragment ${href}`);
    }
  }
  return problems;
}
