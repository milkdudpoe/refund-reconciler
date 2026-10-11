// Renders the privacy policy's Markdown source (docs/store/privacy-policy.md)
// into HTML for the standalone review copy (docs/store/privacy-policy.html) and
// the publisher site's privacy page (publisher-site/privacy.html), so the
// policy text has one source and both HTML forms are derived from it.
//
// Deliberately tiny: it understands only what the policy uses (one `#` title,
// `##` headings, paragraphs, `- ` lists with indented continuation lines, `> `
// notes, **bold**, `code`, [links](url) and [PENDING: …] markers) and throws on
// anything else, so an unsupported construct cannot be silently mangled.

export const POLICY_START = '<!-- policy:start (generated from docs/store/privacy-policy.md by npm run site:policy; do not edit by hand) -->';
export const POLICY_END = '<!-- policy:end -->';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function inlineText(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    // Links to other repository documents make no sense outside the repository.
    if (/^[\w./-]+\.md(#[\w-]*)?$/.test(href)) return label;
    if (!/^(https:\/\/|mailto:|#)/.test(href)) throw new Error(`Unsupported link target in policy: ${href}`);
    return `<a href="${href}">${label}</a>`;
  });
  out = out.replace(/\[PENDING: [^\]]*\]/g, (m) => `<mark class="pending">${m}</mark>`);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  if (/\*|\]\(/.test(out.replace(/<[^>]+>/g, ''))) throw new Error(`Unsupported Markdown in policy line: ${text}`);
  return out;
}

/** Inline Markdown to HTML: code spans first, then links, markers and bold outside them. */
export function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : inlineText(part)))
    .join('');
}

export interface RenderedPolicy {
  title: string;
  /** Body HTML from the title onwards, one block per line group. */
  html: string;
}

export function renderPolicy(markdown: string): RenderedPolicy {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let title: string | null = null;
  let sawHeading = false;
  let i = 0;
  const ids = new Set<string>();

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      if (title !== null) throw new Error('Policy has more than one title');
      title = line.slice(2).trim();
      out.push(`<h1>${inline(title)}</h1>`);
      i++;
    } else if (line.startsWith('## ')) {
      const text = line.slice(3).trim();
      const id = slug(text);
      if (ids.has(id)) throw new Error(`Duplicate policy heading: ${text}`);
      ids.add(id);
      sawHeading = true;
      out.push(`<h2 id="${id}">${inline(text)}</h2>`);
      i++;
    } else if (line.startsWith('>')) {
      const paragraphs: string[][] = [[]];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        const content = (lines[i] ?? '').replace(/^> ?/, '');
        if (content.trim() === '') paragraphs.push([]);
        else paragraphs[paragraphs.length - 1]?.push(content.trim());
        i++;
      }
      const body = paragraphs.filter((p) => p.length > 0).map((p) => `<p>${inline(p.join(' '))}</p>`).join('');
      out.push(`<aside class="draft" role="note">${body}</aside>`);
    } else if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.startsWith('- ')) items.push(l.slice(2).trim());
        else if (l.startsWith('  ') && l.trim() !== '' && items.length > 0) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      const cls = sawHeading ? '' : ' class="policy-meta"';
      out.push(`<ul${cls}>\n${items.map((t) => `  <li>${inline(t)}</li>`).join('\n')}\n</ul>`);
    } else if (/^(#{3,}|\s|\d+\.|\* |\||```)/.test(line)) {
      throw new Error(`Unsupported Markdown block in policy: ${line}`);
    } else {
      const para: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (l.trim() === '' || /^(#|>|- )/.test(l)) break;
        para.push(l.trim());
        i++;
      }
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  if (title === null) throw new Error('Policy has no title');
  return { title, html: out.join('\n') };
}

const STANDALONE_STYLE = `  :root { color-scheme: light dark; --fg: #1d1f23; --bg: #ffffff; --muted: #5a606b; --accent: #2456a6; --note-bg: #fff4d6; --note-border: #b07c00; --mark-bg: #ffe08a; --mark-fg: #1d1f23; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e7e9ee; --bg: #15171b; --muted: #a3a9b4; --accent: #8fb3f0; --note-bg: #3a2f10; --note-border: #e0b040; --mark-bg: #ffd75e; --mark-fg: #15171b; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.8rem; line-height: 1.25; margin: 0 0 1rem; }
  h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; color: var(--accent); }
  a { color: var(--accent); overflow-wrap: anywhere; }
  ul { padding-left: 1.4rem; }
  li { margin: 0.3rem 0; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.92em; overflow-wrap: anywhere; }
  .draft { background: var(--note-bg); border-left: 4px solid var(--note-border); padding: 0.5rem 1rem; margin: 0 0 1.5rem; }
  mark.pending { background: var(--mark-bg); color: var(--mark-fg); font-weight: 700; padding: 0 0.2em; border-radius: 3px; }
  @media print { .draft { border: 2px solid #000; } mark.pending { outline: 2px solid #000; } }`;

/** The standalone review copy, docs/store/privacy-policy.html. */
export function standalonePolicyHtml(policy: RenderedPolicy): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(policy.title)} (unpublished draft)</title>
<!-- Generated from privacy-policy.md by npm run site:policy; do not edit by hand. Standalone: no scripts, fonts or other external resources. Not part of the extension package. -->
<style>
${STANDALONE_STYLE}
</style>
</head>
<body>
<main>
${policy.html}
</main>
</body>
</html>
`;
}

/** Replaces the generated region of publisher-site/privacy.html. */
export function injectPolicy(page: string, policy: RenderedPolicy): string {
  const text = page.replace(/\r\n/g, '\n');
  const start = text.indexOf(POLICY_START);
  const end = text.indexOf(POLICY_END);
  if (start < 0 || end < start || text.indexOf(POLICY_START, start + 1) >= 0) {
    throw new Error('publisher-site/privacy.html must contain the policy markers exactly once, in order');
  }
  return `${text.slice(0, start + POLICY_START.length)}\n${policy.html}\n${text.slice(end)}`;
}
