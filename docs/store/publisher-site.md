# Publisher site and privacy-policy handoff (Tasks 12 to 14)

> **Current status (Task 14): publication files finalized, deployment not
> yet performed.** The owner explicitly approved publishing the reviewed site
> and privacy policy on GitHub Pages under **MJUD**, with
> `exiledeals@gmail.com` as the public support contact ("I approve
> publishing."); that approval covers the reviewed support-email wording and
> the GitHub Pages host, and it persists. Task 14 applied the reviewed final
> edits to the source and the real files now **pass**
> `npm run site:publication-check`. Nothing has been hosted or deployed:
> Pages is not enabled, the manual workflow has **never been run**, no
> setting was changed, nothing was merged by Claude Code, nothing was
> submitted to the Chrome Web Store and no email was sent. The proposed URLs
> below are **not live** and were not requested.
>
> **Candidate publication date: 2026-10-11** (the calendar date in
> America/New_York when Task 14 ran). It is the policy's effective date as
> prepared for the upcoming deployment; **publication has not happened**, and
> choosing the date does not make the policy live. Before the workflow runs,
> the date must be reconciled with the day of the actual first successful
> publication: if review or deployment moves to another day, the effective
> date (and any copy stating it) is updated in a small reviewed change first.
>
> Task 13 added the manual-only deployment workflow source
> (`.github/workflows/publisher-site-pages.yml`) and the read-only
> publication gate; at that time the gate refused the draft by design.

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

The Ubuntu CI job runs `npm run site:publication-check` on the finalized
source (Task 14; read-only, no deployment), then `npm run site:artifact`
(`site:check`, then staging), and uploads **`refund-reconciler-publisher-site`** (kept 14 days):

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
  whether or not the visitor is signed in to GitHub. The policy's
  **This website** section says so for its host, GitHub Pages. The
  extension's "no network requests" statement covers only the extension, not
  the website.
- **Acceptable use (interpretation):** GitHub's
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
  exclude sites primarily for commercial transactions or SaaS, and sensitive
  transactions such as passwords or card numbers. This site is an
  informational project page with no transactions or forms. Published sites
  are limited to 1 GB with a 100 GB/month soft bandwidth limit; this site is
  under 0.2 MB.
- **Deployment method (when authorized):** the manual workflow described in
  [Manual Pages workflow](#manual-pages-workflow-task-13), which uploads
  **only** the staged site files with `actions/upload-pages-artifact` and
  deploys them with `actions/deploy-pages`
  ([Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages),
  [Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)).
  Its source exists since Task 13; it has not been run. The existing CI
  workflow's permissions are unchanged (`contents: read`, no deployment).

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

- **Website and policy publication** has the owner's explicit approval
  (MJUD, `exiledeals@gmail.com`, the **If you email MJUD** wording and the
  GitHub Pages host). It still needs the review of this final source, the
  effective date aligned with the actual publication day, the deployment
  itself and the verified final URLs. It does **not** need store approval or a submitted extension:
  the policy reviewers read must exist before submission.
- **Extension submission** additionally needs: the hosted policy URL entered
  in the dashboard, the exact Developer Dashboard privacy labels and
  certifications, distribution settings, and the owner-operated 0.8.0 toolbar
  check (see [readiness.md](readiness.md)).
- **Extension release** additionally needs Google's review outcome.
  Linking the site from the extension would be a later change, made only
  once the URLs are live.

## Publication gate (Task 13)

```sh
npm run site:publication-check   # read-only; exits non-zero unless the site is publishable
```

It runs everything `site:check` runs (both policy HTML copies and the
images current, the exact seven-file inventory, no scripts, forms or external
resources, relative links and fragments, MJUD and the contact mailto on every
page) and then requires, for publication (`scripts/site/publication.ts`):

- exactly one `- **Effective date:** YYYY-MM-DD` line in
  `docs/store/privacy-policy.md`, a real calendar day (no rollover such as
  `2027-02-30`). The gate cannot tell which day is the true publication
  date, so it imposes no particular day: the owner records the actual
  first-publication date. Copying the review-preparation date
  (2026-10-11) into the field does not by itself establish publication, but
  publishing on the same day the site was prepared is valid, and such a
  date passes;
- no `[PENDING: ...]` marker in the policy, its standalone copy or any page;
- no draft note (`> ` block, rendered as `<aside class="draft">`) and no
  draft-only wording (*unpublished draft*, *not yet in effect*, *not yet
  effective*, *Prepared for review*) in the policy; neither generated copy
  nor the privacy page may call the policy a draft in its `<title>` or meta
  description;
- no review-only banner (`<div class="review-note">`) on the three pages;
- the **This website** host bullet reading exactly as reviewed, minus
  *Planned* and its marker: *"**Host:** GitHub Pages. Like any web host, it
  receives the request … GitHub states that it logs and stores visitors' IP
  addresses for security purposes; see the GitHub Privacy Statement."*;
- the publisher, contact and Limited Use statement in the policy, and the
  homepage's one-click link to `privacy.html#chrome-web-store-user-data-policy`.

It writes nothing, fills in no date and generates no policy text. Since
Task 14 the real, finalized files pass it, and ordinary CI runs it on every
pull request and push to `main` (read-only; no deployment trigger or
permission). The gate does not object to the homepage's accurate statement that
the **extension** is an unpublished beta, not in the Chrome Web Store; that
stays true until a store release and is not the same as publishing a policy
that is not in effect.

In Task 13 the then-draft was refused with 15 problems (historical). Since
Task 14, `tests/unit/publication-gate.test.ts` requires the **real** source
to pass with current copies, the approved publisher and contact and one valid
effective date, without changing any file. The same 15 refusals are pinned on
an explicit **draft fixture**: temporary copies of the finalized files with
the former draft note, *not yet effective* date, **Prepared for review**
line, planned-host wording, review banners and draft meta description
restored from test data. Finalized fixtures with arbitrary dates (the same
day 2026-10-11, 2026-10-12, leap day 2028-02-29) pass, and each remaining
draft element (a leftover **Prepared for review** line included, whatever
its date), invalid or missing dates, stale policy HTML, extra files and
external resources fail on their own. Fixtures never modify the real files
or their date.

## Manual Pages workflow (Task 13)

`.github/workflows/publisher-site-pages.yml` (**not run**):

- **Trigger:** `workflow_dispatch` only. Both jobs run only when the
  selected ref is `refs/heads/main`; any other branch or tag is skipped and
  nothing is deployed.
- **Commit:** checks out `github.sha` (the dispatched commit) without
  persisted credentials, confirms `HEAD` equals it and fetches nothing else.
- **Build job** (`contents: read`, 15 min): pinned Node from `.nvmrc`,
  `npm ci`, `typecheck`, `lint`, `npm test`, **`site:publication-check`**, then
  `site:artifact` with the provenance commit set to `github.sha`; the report
  must name that commit as both source and checkout, with a clean working
  tree. It does not build the extension or regenerate store screenshots.
- **Artifacts:** the provenance report is uploaded separately as the normal
  artifact `refund-reconciler-publisher-site-report`. The Pages artifact is
  **only** `artifacts/publisher-site/site/` (the seven files), never the
  repository root or the report's directory. The report describes the staged
  files; it is not evidence that a deployment happened.
- **Deploy job:** `needs: build`, the only job with `pages: write` and
  `id-token: write`, environment `github-pages` with the deployment URL as
  its output, `actions/deploy-pages@v4`, 10 min.
- **Concurrency:** group `pages`, `cancel-in-progress: false`, so an
  in-progress deployment finishes and a later run waits.
- **Not done by the workflow:** it does not enable Pages or change any
  setting (no `actions/configure-pages` enablement). Before a first run the
  owner sets **Settings → Pages → Build and deployment → Source** to
  **GitHub Actions**. GitHub recommends a deployment protection rule so that
  only the default branch can deploy to the `github-pages` environment; any
  rule or required reviewer is the owner's service setting.

Checked in Task 13 without running anything: `actionlint` 1.7.7 reports no
problems in either workflow, and the triggers, permissions, branch
condition, `needs` and upload path above were inspected in the YAML. The
publication text is finalized as of Task 14, so the gate no longer stops a
run on `main`; the workflow has still not been run.

## Deployment procedure (approved, not yet performed)

Publication is approved by the owner; that approval covers these steps and
no further approval is needed. None of them has been performed.

1. **Review.** Independent review of the Task 14 pull request (this final
   source); the reviewed revision lands on `main` with CI green.
2. **Date.** Confirm the policy's effective date (candidate **2026-10-11**)
   equals the day of the actual first successful publication. If not, a
   small reviewed change sets the actual date (`docs/store/privacy-policy.md`,
   then `npm run site:policy`, `npm test`, `npm run site:publication-check`)
   before running the workflow.
3. **Settings.** Set **Settings → Pages → Build and deployment → Source** to
   **GitHub Actions** (optionally adding the `github-pages` protection rule).
4. **Run.** Explicitly run *Publisher site (manual Pages deployment)* on
   `main` from the Actions tab.
5. **Verify and record.** Over HTTPS, check the live home, privacy and
   support pages, images, relative navigation, that no external resource
   loads, and the Limited Use anchor
   (`privacy.html#chrome-web-store-user-data-policy`). Record the deployed
   commit, the workflow run and deployment result, the actual publication
   date and the verified URLs in [readiness.md](readiness.md) and
   [privacy-practices.md](privacy-practices.md#privacy-policy-url). Only then
   use those URLs in the store listing and Developer Dashboard.

Website publication is separate from extension submission. The site may be
published before the extension is submitted; the extension still needs the
owner-operated **0.8.0** toolbar check (the earlier 0.6.0 owner report does
not verify this beta), the Developer Dashboard privacy labels,
certifications and distribution choices, and Google's review.
