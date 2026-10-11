// Focused checks of the static publisher site (publisher-site/) and the policy
// copies derived from docs/store/privacy-policy.md. The copy itself is
// reviewed by people; these tests check structure, derivation and isolation.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowedProductionPath } from '../../scripts/beta/verify.ts';
import { checkSite, CONTACT_EMAIL, PUBLISHER, SITE_ASSET_SOURCES, SITE_DIR, SITE_FILES } from '../../scripts/site/checks.ts';
import { injectPolicy, renderPolicy, standalonePolicyHtml } from '../../scripts/site/policy.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const read = async (path: string): Promise<string> => (await readFile(join(ROOT, path), 'utf8')).replace(/\r\n/g, '\n');

describe('publisher site', () => {
  it('passes the static site checks (inventory, no scripts/forms/external resources, links resolve)', async () => {
    expect(await checkSite(ROOT)).toEqual([]);
  });

  it('has both policy HTML forms generated from the Markdown source', async () => {
    const policy = renderPolicy(await read('docs/store/privacy-policy.md'));
    expect(await read('docs/store/privacy-policy.html')).toBe(standalonePolicyHtml(policy));
    const page = await read(`${SITE_DIR}/privacy.html`);
    expect(page).toBe(injectPolicy(page, policy));
    expect(page).toContain(policy.html);
  });

  it('keeps copied images byte-identical to their reviewed sources', async () => {
    for (const [file, source] of Object.entries(SITE_ASSET_SOURCES)) {
      const [copy, original] = await Promise.all([readFile(join(ROOT, SITE_DIR, file)), readFile(join(ROOT, source))]);
      expect(copy.equals(original), file).toBe(true);
    }
  });

  it('names the publisher and contact, and leaves only publication fields pending', async () => {
    const md = await read('docs/store/privacy-policy.md');
    expect(md).toContain(`**Publisher:** ${PUBLISHER}`);
    expect(md).toContain(`**Contact:** [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})`);
    const pending = [...md.matchAll(/\[PENDING: ([^\]]*)\]/g)].map((m) => m[1]);
    expect(pending).toEqual(['set to the date this policy is first published', 'confirm when the site is published']);
    expect(md).toMatch(/\*\*Effective date:\*\* not yet effective/);
    expect(md).toContain('Limited Use requirements');
    expect(md).not.toMatch(/publisher or developer name|support URL controlled by the publisher/);
  });

  it('reaches the Limited Use statement from the homepage in one click', async () => {
    const home = await read(`${SITE_DIR}/index.html`);
    expect(home).toContain('href="privacy.html#chrome-web-store-user-data-policy"');
    const privacy = await read(`${SITE_DIR}/privacy.html`);
    expect(privacy).toMatch(/<h2 id="chrome-web-store-user-data-policy">[^<]*<\/h2>\n<p>The use of information received by Refund Reconciler adheres to the/);
  });

  it('can never enter the extension package', () => {
    for (const file of SITE_FILES) {
      expect(isAllowedProductionPath(file), file).toBe(false);
      expect(isAllowedProductionPath(`${SITE_DIR}/${file}`), file).toBe(false);
    }
  });
});

describe('policy renderer', () => {
  it('renders the supported subset and refuses anything else', () => {
    const { html } = renderPolicy('# T\n\n> **Note** one\n> two\n\n- **A:** [x@y.z](mailto:x@y.z)\n- B [PENDING: b]\n  more\n\n## Sec one\n\nText `a<b` and [doc](other.md).\n');
    expect(html).toBe(
      [
        '<h1>T</h1>',
        '<aside class="draft" role="note"><p><strong>Note</strong> one two</p></aside>',
        '<ul class="policy-meta">\n  <li><strong>A:</strong> <a href="mailto:x@y.z">x@y.z</a></li>\n  <li>B <mark class="pending">[PENDING: b]</mark> more</li>\n</ul>',
        '<h2 id="sec-one">Sec one</h2>',
        '<p>Text <code>a&lt;b</code> and doc.</p>',
      ].join('\n'),
    );
    expect(() => renderPolicy('# T\n\n### Deep\n')).toThrow(/Unsupported/);
    expect(() => renderPolicy('# T\n\n1. one\n')).toThrow(/Unsupported/);
    expect(() => renderPolicy('# T\n\n[x](http://insecure.example)\n')).toThrow(/Unsupported link/);
    expect(() => renderPolicy('# T\n\n*emphasis*\n')).toThrow(/Unsupported Markdown/);
  });
});
