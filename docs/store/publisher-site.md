# Publisher site and privacy-policy handoff (Task 12)

> **Prepared, not published.** The files below are ready for the owner's
> review. Nothing has been hosted or deployed: GitHub Pages is not enabled,
> no DNS, domain, hosting account or deployment workflow exists, nothing was
> submitted to the Chrome Web Store, and no email was sent. The proposed URLs
> below are **not live** and were not requested.

- **Publisher:** MJUD (supplied by the owner)
- **Public contact:** `exiledeals@gmail.com` (supplied by the owner)
- **Existing website:** none (stated by the owner)
- **Extension:** Refund Reconciler 0.8.0, data-practices version 1, unchanged.
  The extension does not link to the site, and must not until the site is live.

## Site folder inventory

`publisher-site/` is self-contained: plain HTML and CSS, system fonts, no
JavaScript, forms, cookies, analytics, embeds, external fonts or remote
images. All links between pages are relative, so the folder works at a
repository subpath (`/refund-reconciler/`) or at the root of another host.

| File | What it is | Source |
| --- | --- | --- |
| `index.html` | Homepage: product, publisher, beta status, what it does and does not do, local encrypted storage, plaintext exports, no passphrase recovery, links to Privacy, Support and the Limited Use statement | hand-written |
| `privacy.html` | The complete privacy policy inside the site layout | page frame hand-written; the policy region is **generated** from `docs/store/privacy-policy.md` |
| `support.html` | Contact (mailto), what to include and not include, self-help (guide, capture refusals, unlock/forgotten passphrase, backups) | hand-written |
| `styles.css` | Light/dark theme, focus styles, responsive layout | hand-written |
| `assets/icon-32.png` | Favicon | byte copy of `public/icons/icon-32.png` |
| `assets/icon-128.png` | Header logo | byte copy of `public/icons/icon-128.png` |
| `assets/example-item-evidence.png` | Example screenshot (synthetic data, unchanged, with its product warning) | byte copy of `store-assets/screenshot-2-item-evidence-1280x800.png` (Task 11) |

`npm run site:check` fails if the folder contains any other file.

## One policy source

`docs/store/privacy-policy.md` is the only text that is edited. Both HTML
forms are derived from it:

```sh
npm run site:policy   # regenerate docs/store/privacy-policy.html and the policy region of
                      # publisher-site/privacy.html; refresh the three copied images
npm run site:check    # change nothing; fail if either HTML form or an image copy is stale,
                      # or the site has unexpected files, scripts, forms or external resources
```

The renderer (`scripts/site/policy.ts`) understands only the Markdown the
policy uses and refuses anything else. Run against the Task 11 Markdown, it
reproduces the reviewed Task 11 `privacy-policy.html` body exactly. The unit
test `tests/unit/publisher-site.test.ts` (run by `npm test` on Ubuntu and
Windows) checks that both HTML forms equal a fresh render, so the three forms
cannot drift silently.

## Local preview

No dependency or server is needed: open `publisher-site/index.html` in a
browser. To preview at the proposed Pages subpath, serve the repository's
parent layout from any static server, for example:

```sh
mkdir -p /tmp/site-preview && ln -sfn "$PWD/publisher-site" /tmp/site-preview/refund-reconciler
python3 -m http.server 8000 --directory /tmp/site-preview   # then open http://localhost:8000/refund-reconciler/
```

## CI artifact

The Ubuntu CI job runs `npm run site:artifact` (`site:check`, then staging)
and uploads **`refund-reconciler-publisher-site`** (kept 14 days):

- `site/`: exactly the seven files above;
- `publisher-site-report.json`, **outside** `site/`: generation label
  (`ci-final-head` only in CI), the head commit (`sourceCommit`), the commit
  GitHub checked out (`checkoutCommit`, a merge commit for pull requests),
  working-tree status, the policy source's SHA-256, and each file's bytes and
  SHA-256.

The CI log also prints `sha256sum` of every staged file. The artifact holds
no extension ZIP, source code, profile, dependency, build or test output or
other document. The site folder is not under `public/` and the beta
packager's allowlist (`scripts/beta/verify.ts`) refuses every site path, so
the site never enters the extension package.

## Hosting plan (proposed)

**Candidate:** GitHub Pages, a project site for this repository.

Checked on 2026-10-11 (read-only):

- The repository `milkdudpoe/refund-reconciler` is **public** and Pages is
  **not enabled** (`has_pages: false`, GitHub API via the session's GitHub
  tools). GitHub's docs say that on GitHub Free the repository must be public
  ([Creating a GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)),
  so a public repository is eligible on any plan. The owner's plan itself was
  not inspected. Eligibility is still confirmed only when the owner opens
  **Settings → Pages**.
- Project sites are served at `http(s)://<owner>.github.io/<repositoryname>`
  ([What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)).
  The **proposed, unverified** URLs are therefore:
  - `https://milkdudpoe.github.io/refund-reconciler/`
  - `https://milkdudpoe.github.io/refund-reconciler/privacy.html`
  - `https://milkdudpoe.github.io/refund-reconciler/support.html`

  No domain ownership, HTTP response or certificate has been checked; none
  of these URLs exists yet.
- **Visitor logging:** the same page says that when a Pages site is visited,
  the visitor's IP address is logged and stored for security purposes,
  whether or not the visitor is signed in to GitHub. The draft policy's
  **This website** section says so, labelled as a planned host. The
  extension's "no network requests" statement covers only the extension, not
  the website.
- **Acceptable use (interpretation):** GitHub's
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
  exclude sites primarily for commercial transactions or SaaS, and sensitive
  transactions such as passwords or card numbers. This site is an
  informational project page with no transactions or forms. Published sites
  are limited to 1 GB with a 100 GB/month soft bandwidth limit; this site is
  under 0.2 MB.
- **Deployment method (when authorized):** a custom GitHub Actions workflow
  that uploads **only** `publisher-site/` with `actions/upload-pages-artifact`
  and deploys it with `actions/deploy-pages`; the deploy job needs
  `pages: write` and `id-token: write`
  ([Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
  [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)).
  This keeps the rest of the repository out of the site. **No such workflow
  is added in this task**, and the existing CI permissions are unchanged.

If GitHub Pages is not used, the folder can be uploaded unchanged to any
static host. The policy's **This website** section must then be rewritten
for that host before publication.

## Chrome Web Store sources (rechecked 2026-10-11)

- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
  (footer "Last updated 2022-11-01"): an affirmative statement that the
  extension's use of data complies with the Limited Use restrictions must be
  disclosed on a website belonging to the extension, for example via a link
  on a homepage to a dedicated page or the privacy policy. The homepage links
  straight to `privacy.html#chrome-web-store-user-data-policy` (one click), in
  the body and the footer.
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
  (footer 2016-04-23): Q3 and Q14 say that handling data only locally still
  needs disclosure and a posted privacy policy.
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
  (footer 2020-06-12): the dashboard disclosures are shown to users and should
  be consistent with the privacy policy URL given to the store.

These are interpretations for planning, not a compliance certification.

## What depends on what

- **Website and policy publication** needs: the owner's review of these
  files (in particular the **If you email MJUD** wording, which describes
  MJUD's own handling of support email), a host, the effective date and the
  final URLs. It does **not** need store approval or a submitted extension:
  the policy reviewers read must exist before submission.
- **Extension submission** additionally needs: the hosted policy URL entered
  in the dashboard, the exact Developer Dashboard privacy labels and
  certifications, distribution settings, and the owner-operated 0.8.0 toolbar
  check (see [readiness.md](readiness.md)).
- **Extension release** additionally needs Google's review outcome.
  Linking the site from the extension would be a later change, made only
  once the URLs are live.

## Final edits at publication (owner-authorized step)

1. Choose the host. For GitHub Pages: enable Pages with **GitHub Actions** as
   the source and add the artifact-only deployment workflow described above.
2. In `docs/store/privacy-policy.md`:
   - replace the draft note with nothing (or a short "Current version" line);
   - set **Effective date** to the actual publication date (remove its
     `[PENDING]` marker) and remove the **Prepared for review** line;
   - in **This website**, confirm the host description matches the actual
     host and remove its `[PENDING]` marker.
3. Remove the review-only banner (`<div class="review-note">…</div>`) from
   the three pages; it is not generated. Optionally drop the `.review-note`
   CSS.
4. Run `npm run site:policy` and `npm run site:check`, update the expected
   `[PENDING]` list in `tests/unit/publisher-site.test.ts` (it pins the two
   draft-only markers), run `npm test`, then review the diff.
5. Deploy, then confirm that each final URL returns the expected page over
   HTTPS, that relative links and images work there, and that the Limited
   Use link lands on the right heading.
6. Record the live privacy-policy URL and effective date in
   [readiness.md](readiness.md) and
   [privacy-practices.md](privacy-practices.md#privacy-policy-url), and use
   that URL in the Developer Dashboard.
