// The publication gate (npm run site:publication-check) on the real draft and
// on isolated fixture copies. The "finalized" fixture applies the documented
// final edits (docs/store/publisher-site.md) to temporary copies of the
// reviewed files; it is test data, not owner approval or an effective policy.

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedProductionPath } from '../../scripts/beta/verify.ts';
import { SITE_ASSET_SOURCES, SITE_DIR, SITE_FILES } from '../../scripts/site/checks.ts';
import { checkPublication, isCalendarDate, publicationProblems, readPublicationTexts, REVIEW_PREPARATION_DATE } from '../../scripts/site/publication.ts';
import { checkSiteSources, lf, POLICY_HTML, POLICY_MD, SITE_PRIVACY, writeDerivedFiles } from '../../scripts/site/sources.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const EFFECTIVE = '2027-03-15';
const FIXTURE_FILES = [POLICY_MD, POLICY_HTML, ...SITE_FILES.map((f) => `${SITE_DIR}/${f}`), ...Object.values(SITE_ASSET_SOURCES)];

let scratch: string;
let finalized: string;

async function copyRepoFiles(to: string): Promise<void> {
  for (const file of FIXTURE_FILES) {
    await mkdir(dirname(join(to, file)), { recursive: true });
    await cp(join(ROOT, file), join(to, file));
  }
}

const readText = async (root: string, file: string): Promise<string> => lf(await readFile(join(root, file), 'utf8'));
async function edit(root: string, file: string, change: (text: string) => string): Promise<void> {
  const before = await readText(root, file);
  const after = change(before);
  expect(after, `fixture edit of ${file} changed nothing`).not.toBe(before);
  await writeFile(join(root, file), after);
}

/** The documented final edits, applied to fixture copies. */
async function finalize(root: string, effectiveDate: string): Promise<void> {
  await edit(root, POLICY_MD, (md) =>
    md
      .replace(/\n(> .*\n|>\n)+\n/, '\n')
      .replace(/^- \*\*Effective date:\*\* .*$/m, `- **Effective date:** ${effectiveDate}`)
      .replace(/^- \*\*Prepared for review:\*\* .*\n/m, '')
      .replace('- **Planned host [PENDING: confirm when the site is published]:** GitHub\n  Pages.', '- **Host:** GitHub Pages.'),
  );
  for (const page of ['index.html', 'privacy.html', 'support.html']) {
    await edit(root, `${SITE_DIR}/${page}`, (html) => html.replace(/<div class="review-note" role="note">\n.*\n<\/div>\n/, ''));
  }
  await edit(root, SITE_PRIVACY, (html) => html.replace('privacy policy (unpublished draft).', 'privacy policy.'));
  await writeDerivedFiles(root);
}

/** A fresh copy of the finalized fixture. */
async function finalizedCopy(name: string): Promise<string> {
  const dir = join(scratch, name);
  await cp(finalized, dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'publication-gate-'));
  finalized = join(scratch, 'finalized');
  await copyRepoFiles(finalized);
  await finalize(finalized, EFFECTIVE);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('publication gate on the current draft', () => {
  it('refuses the real draft with actionable errors and changes no file', async () => {
    const hash = async (): Promise<string[]> =>
      Promise.all(FIXTURE_FILES.map(async (f) => `${f} ${createHash('sha256').update(await readFile(join(ROOT, f))).digest('hex')}`));
    const before = await hash();
    const problems = await checkPublication(ROOT);
    expect(await hash()).toEqual(before);

    expect(await checkSiteSources(ROOT)).toEqual([]); // ordinary site:check still accepts the draft
    expect(problems).toEqual([
      `${POLICY_MD} effective date "not yet effective [PENDING: set to the date this policy is first published]" is not a valid YYYY-MM-DD calendar date; set it to the actual first-publication date`,
      `${POLICY_MD} still has a "> " note (the draft note); remove it before publication`,
      `${POLICY_MD} still contains draft-only wording ("Unpublished draft"); finalize the draft note and metadata lines`,
      `${POLICY_MD} "This website" still describes a planned host; confirm the host`,
      expect.stringMatching(/^docs\/store\/privacy-policy\.md "This website" must confirm GitHub Pages and its IP-address logging/),
      `${POLICY_HTML} still contains a [PENDING: ...] marker`,
      `${POLICY_HTML} still contains the policy's draft note`,
      `${POLICY_HTML} still labels the policy a draft in its <title> or meta description`,
      `${SITE_DIR}/index.html still has the review-only banner (<div class="review-note">); remove it`,
      `${SITE_DIR}/privacy.html still contains a [PENDING: ...] marker`,
      `${SITE_DIR}/privacy.html still has the review-only banner (<div class="review-note">); remove it`,
      `${SITE_DIR}/privacy.html still contains the policy's draft note`,
      `${SITE_DIR}/privacy.html still labels the policy a draft in its <title> or meta description`,
      `${SITE_DIR}/support.html still has the review-only banner (<div class="review-note">); remove it`,
      `${POLICY_MD} still contains a [PENDING: ...] marker`,
    ]);
  });
});

describe('publication gate on a finalized fixture', () => {
  it('passes with one coherent effective date and the confirmed host', async () => {
    expect(await checkPublication(finalized)).toEqual([]);
    const md = await readText(finalized, POLICY_MD);
    expect([...md.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0])).toEqual([EFFECTIVE]);
    for (const file of [POLICY_HTML, SITE_PRIVACY]) expect(await readText(finalized, file)).toContain(`<strong>Effective date:</strong> ${EFFECTIVE}</li>`);
    expect(await readText(finalized, POLICY_HTML)).toContain('<title>Refund Reconciler privacy policy</title>');
  });

  it('changes only the documented lines of the reviewed policy', async () => {
    const draft = (await readText(ROOT, POLICY_MD)).split('\n');
    const final = (await readText(finalized, POLICY_MD)).split('\n');
    const removed = draft.filter((l) => !final.includes(l));
    const added = final.filter((l) => !draft.includes(l));
    expect(removed.every((l) => /^>|Effective date|Prepared for review|Planned host|^ {2}Pages\./.test(l)), removed.join('\n')).toBe(true);
    expect(added).toEqual([`- **Effective date:** ${EFFECTIVE}`, expect.stringMatching(/^- \*\*Host:\*\* GitHub Pages\. Like any web host/)]);
  });

  it('allows an honest statement that the extension is an unpublished beta', async () => {
    const home = await readText(finalized, `${SITE_DIR}/index.html`);
    expect(home).toContain('Unpublished beta &middot; local preview');
    expect(home).toContain('not yet available to install');
    expect(await readText(finalized, POLICY_MD)).toContain('Refund Reconciler (local preview) Chrome extension, version 0.8.0');
    expect(await checkPublication(finalized)).toEqual([]);
  });
});

describe('publication gate refuses each remaining draft element on its own', () => {
  const problemsWith = async (change: (md: string) => string): Promise<string[]> => {
    const texts = await readPublicationTexts(finalized);
    return publicationProblems({ ...texts, policyMarkdown: change(texts.policyMarkdown) });
  };
  const withDate = (value: string) => (md: string) => md.replace(`**Effective date:** ${EFFECTIVE}`, `**Effective date:** ${value}`);

  it('a missing effective date', async () => {
    expect(await problemsWith((md) => md.replace(/^- \*\*Effective date:\*\* .*\n/m, ''))).toEqual([
      `${POLICY_MD} must have exactly one "- **Effective date:** YYYY-MM-DD" line (found 0)`,
    ]);
  });

  it.each(['2027-02-30', '2027-13-01', '2027-3-15', '15/03/2027', '2027-03-15T00:00', 'pending', ''])('an invalid effective date %j', async (value) => {
    expect(await problemsWith(withDate(value))).toEqual([expect.stringContaining(`effective date "${value}" is not a valid YYYY-MM-DD calendar date`)]);
  });

  it('the review-preparation date as effective date', async () => {
    expect(await problemsWith(withDate(REVIEW_PREPARATION_DATE))).toEqual([expect.stringContaining('is the review-preparation date')]);
  });

  it('a residual [PENDING] marker (policy and both generated copies)', async () => {
    const root = await finalizedCopy('pending');
    await edit(root, POLICY_MD, (md) => md.replace('## Contact\n', '## Contact\n\nPostal address [PENDING: add].\n'));
    await writeDerivedFiles(root);
    expect(await checkPublication(root)).toEqual([
      `${POLICY_HTML} still contains a [PENDING: ...] marker`,
      `${SITE_PRIVACY} still contains a [PENDING: ...] marker`,
      `${POLICY_MD} still contains a [PENDING: ...] marker`,
    ]);
  });

  it('a draft policy note', async () => {
    const root = await finalizedCopy('draft-note');
    const draftNote = (await readText(ROOT, POLICY_MD)).match(/\n((> .*\n|>\n)+)\n/)?.[1] ?? '';
    expect(draftNote).toMatch(/^> \*\*Unpublished draft, not yet in effect\.\*\*/);
    await edit(root, POLICY_MD, (md) => md.replace('\n\n- **Publisher:**', `\n\n${draftNote}\n- **Publisher:**`));
    await writeDerivedFiles(root);
    expect(await checkPublication(root)).toEqual([
      `${POLICY_MD} still has a "> " note (the draft note); remove it before publication`,
      `${POLICY_MD} still contains draft-only wording ("Unpublished draft"); finalize the draft note and metadata lines`,
      `${POLICY_HTML} still contains the policy's draft note`,
      `${POLICY_HTML} still labels the policy a draft in its <title> or meta description`,
      `${SITE_PRIVACY} still contains the policy's draft note`,
    ]);
  });

  it('a remaining review banner', async () => {
    const root = await finalizedCopy('banner');
    const banner = (await readText(ROOT, `${SITE_DIR}/support.html`)).match(/<div class="review-note"[\s\S]*?\n<\/div>\n/)?.[0] ?? '';
    await edit(root, `${SITE_DIR}/support.html`, (html) => html.replace('</header>\n', `</header>\n${banner}`));
    expect(await checkPublication(root)).toEqual([`${SITE_DIR}/support.html still has the review-only banner (<div class="review-note">); remove it`]);
  });

  it('a host that is still only planned, or reworded', async () => {
    expect(await problemsWith((md) => md.replace('- **Host:** GitHub Pages.', '- **Planned host:** GitHub Pages.'))).toEqual([
      `${POLICY_MD} "This website" still describes a planned host; confirm the host`,
      expect.stringContaining('"This website" must confirm GitHub Pages and its IP-address logging'),
    ]);
    expect(await problemsWith((md) => md.replace('IP address. GitHub states', 'IP address. GitHub may state'))).toEqual([expect.stringContaining('must confirm GitHub Pages and its IP-address logging')]);
  });
});

describe('publication gate keeps the ordinary site checks', () => {
  it('cannot bypass stale policy HTML', async () => {
    const root = await finalizedCopy('stale');
    await edit(root, POLICY_MD, (md) => md.replace('is not sold', 'is never sold'));
    expect(await checkPublication(root)).toEqual([
      `${POLICY_HTML} is out of date with ${POLICY_MD}; run npm run site:policy`,
      `${SITE_PRIVACY} is out of date with ${POLICY_MD}; run npm run site:policy`,
    ]);
  });

  it('cannot bypass extra site files, stale images or external resources', async () => {
    const root = await finalizedCopy('extra');
    await writeFile(join(root, SITE_DIR, 'CNAME'), 'example.com\n');
    await writeFile(join(root, SITE_DIR, 'assets/icon-32.png'), 'not the icon');
    await edit(root, `${SITE_DIR}/support.html`, (html) => html.replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="https://cdn.example/x.css">'));
    const problems = await checkPublication(root);
    expect(problems).toContain(`${SITE_DIR}/assets/icon-32.png differs from public/icons/icon-32.png; run npm run site:policy`);
    expect(problems).toContainEqual(expect.stringMatching(/^site inventory differs: found \[CNAME, /));
    expect(problems).toContain(`${SITE_DIR}/support.html loads a resource that is not a local site file: https://cdn.example/x.css`);
  });

  it('cannot bypass a missing Limited Use link or contact', async () => {
    const root = await finalizedCopy('limited-use');
    await edit(root, `${SITE_DIR}/index.html`, (html) => html.replaceAll('href="privacy.html#chrome-web-store-user-data-policy"', 'href="privacy.html"'));
    expect(await checkPublication(root)).toEqual([`${SITE_DIR}/index.html must link to privacy.html#chrome-web-store-user-data-policy (one click to the Limited Use statement)`]);
    expect(await problemsWithContact()).toEqual([`${POLICY_MD} must give the contact exiledeals@gmail.com`]);
    async function problemsWithContact(): Promise<string[]> {
      const texts = await readPublicationTexts(finalized);
      return publicationProblems({ ...texts, policyMarkdown: texts.policyMarkdown.replace('- **Contact:**', '- **Email:**') });
    }
  });
});

describe('calendar dates', () => {
  it('accepts real days only, without rollover', () => {
    expect(['2027-03-15', '2028-02-29', '2027-12-31', '2027-01-01'].every(isCalendarDate)).toBe(true);
    expect(['2027-02-29', '2027-02-30', '2027-04-31', '2027-00-10', '2027-13-01', '2027-01-00', '27-01-01', ' 2027-01-01'].some(isCalendarDate)).toBe(false);
  });
});

describe('deployment files stay out of the extension package', () => {
  it('refuses the workflow, the gate and the staged report', () => {
    for (const path of [
      '.github/workflows/publisher-site-pages.yml',
      'scripts/site/publication.ts',
      'scripts/site/sources.ts',
      'artifacts/publisher-site/publisher-site-report.json',
      'artifacts/publisher-site/site/index.html',
      'site/index.html',
      'publisher-site-report.json',
    ]) {
      expect(isAllowedProductionPath(path), path).toBe(false);
    }
  });
});
