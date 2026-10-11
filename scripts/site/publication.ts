// The publication gate (npm run site:publication-check): the extra
// requirements for actually publishing the site, on top of site:check. Reads
// only; it never fills in dates, removes notes or rewrites the policy. The
// draft prepared for review fails it by design, while site:check still passes.
// See docs/store/publisher-site.md.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTACT_EMAIL, PAGES, PUBLISHER, SITE_DIR } from './checks.ts';
import { checkSiteSources, lf, POLICY_HTML, POLICY_MD } from './sources.ts';

export const LIMITED_USE_LINK = 'privacy.html#chrome-web-store-user-data-policy';

/**
 * The reviewed GitHub Pages bullet of the policy's "This website" section, as
 * it must read once the host is confirmed: the draft wording without
 * "Planned" and its [PENDING] marker (whitespace-normalized).
 */
export const CONFIRMED_HOST_BULLET =
  "- **Host:** GitHub Pages. Like any web host, it receives the request your browser makes when you open a page, including your IP address. GitHub states that it logs and stores visitors' IP addresses for security purposes; see the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).";

/** The texts the gate inspects, already read (LF line endings). */
export interface PublicationTexts {
  /** docs/store/privacy-policy.md */
  policyMarkdown: string;
  /** docs/store/privacy-policy.html */
  policyHtml: string;
  /** The deployable pages, keyed by file name (index.html, privacy.html, support.html). */
  pages: ReadonlyMap<string, string>;
}

/** True only for a real YYYY-MM-DD calendar day (no rollover such as 2027-02-30). */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Draft-only wording of the policy itself (the extension's own beta status is not draft wording). */
const DRAFT_POLICY_WORDING = /unpublished draft|not yet in effect|not yet effective|does not apply to anyone yet|prepared for review/i;

/** Publication requirements on the texts alone. Returns problems (empty when publishable). */
export function publicationProblems({ policyMarkdown, policyHtml, pages }: PublicationTexts): string[] {
  const problems: string[] = [];
  const md = lf(policyMarkdown);

  const dates = [...md.matchAll(/^- \*\*Effective date:\*\* ?(.*)$/gm)].map((m) => (m[1] ?? '').trim());
  if (dates.length !== 1) {
    problems.push(`${POLICY_MD} must have exactly one "- **Effective date:** YYYY-MM-DD" line (found ${dates.length})`);
  } else {
    const date = dates[0] ?? '';
    if (!isCalendarDate(date)) {
      problems.push(`${POLICY_MD} effective date "${date}" is not a valid YYYY-MM-DD calendar date; set it to the actual first-publication date`);
    }
  }

  if (/^>/m.test(md)) problems.push(`${POLICY_MD} still has a "> " note (the draft note); remove it before publication`);
  const draftWording = DRAFT_POLICY_WORDING.exec(md);
  if (draftWording) problems.push(`${POLICY_MD} still contains draft-only wording ("${draftWording[0]}"); finalize the draft note and metadata lines`);
  if (/Planned host/i.test(md)) problems.push(`${POLICY_MD} "This website" still describes a planned host; confirm the host`);
  if (!squash(md).includes(CONFIRMED_HOST_BULLET)) {
    problems.push(`${POLICY_MD} "This website" must confirm GitHub Pages and its IP-address logging with the reviewed wording: ${CONFIRMED_HOST_BULLET}`);
  }
  if (!md.includes(`- **Publisher:** ${PUBLISHER}`)) problems.push(`${POLICY_MD} must name the publisher ${PUBLISHER}`);
  if (!md.includes(`- **Contact:** [${CONTACT_EMAIL}](mailto:${CONTACT_EMAIL})`)) problems.push(`${POLICY_MD} must give the contact ${CONTACT_EMAIL}`);
  if (!md.includes('## Chrome Web Store User Data Policy') || !md.includes('including the Limited Use requirements')) {
    problems.push(`${POLICY_MD} must keep the Chrome Web Store User Data Policy (Limited Use) statement`);
  }

  const html = new Map<string, string>([[POLICY_HTML, lf(policyHtml)]]);
  for (const [page, text] of pages) html.set(`${SITE_DIR}/${page}`, lf(text));
  for (const page of PAGES) if (!pages.has(page)) problems.push(`${SITE_DIR}/${page} is missing`);
  for (const [file, text] of html) {
    if (/\[PENDING:/.test(text)) problems.push(`${file} still contains a [PENDING: ...] marker`);
    if (/class="review-note"/.test(text)) problems.push(`${file} still has the review-only banner (<div class="review-note">); remove it`);
    if (/class="draft"/.test(text)) problems.push(`${file} still contains the policy's draft note`);
    const labels = [/<title>([^<]*)<\/title>/.exec(text)?.[1], /<meta name="description" content="([^"]*)"/.exec(text)?.[1]];
    if (labels.some((label) => /\bdrafts?\b/i.test(label ?? ''))) problems.push(`${file} still labels the policy a draft in its <title> or meta description`);
  }
  if (/\[PENDING:/.test(md)) problems.push(`${POLICY_MD} still contains a [PENDING: ...] marker`);
  if (!(pages.get('index.html') ?? '').includes(`href="${LIMITED_USE_LINK}"`)) {
    problems.push(`${SITE_DIR}/index.html must link to ${LIMITED_USE_LINK} (one click to the Limited Use statement)`);
  }
  return problems;
}

/** Reads the texts the gate inspects from a repository root. */
export async function readPublicationTexts(root: string): Promise<PublicationTexts> {
  const read = async (path: string): Promise<string> => lf(await readFile(join(root, path), 'utf8'));
  const pages = new Map<string, string>();
  for (const page of PAGES) pages.set(page, await read(`${SITE_DIR}/${page}`));
  return { policyMarkdown: await read(POLICY_MD), policyHtml: await read(POLICY_HTML), pages };
}

/**
 * site:publication-check: everything site:check requires (current policy copies
 * and images, inventory, local resources, links), plus the publication
 * requirements above. Reads only.
 */
export async function checkPublication(root: string): Promise<string[]> {
  return [...(await checkSiteSources(root)), ...publicationProblems(await readPublicationTexts(root))];
}
