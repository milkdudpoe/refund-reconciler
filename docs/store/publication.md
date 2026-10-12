# Publisher site publication record (Task 15)

> **Published.** The approved MJUD publisher site and privacy policy are live
> on GitHub Pages since **2026-10-11 (America/New_York)**. This records what
> happened; it is not store approval and not an extension release. The
> extension (0.8.0) is still an unpublished beta and has not been submitted
> to the Chrome Web Store.

## Authorization and reviewed source

- **Owner authorization:** after reviewing the proposed MJUD site and
  policy, GitHub Pages hosting and `exiledeals@gmail.com` as public support
  contact, the owner said **"I approve publishing."** (recorded in Task 14).
- **Reviewed source:** PR
  [milkdudpoe/refund-reconciler#14](https://github.com/milkdudpoe/refund-reconciler/pull/14),
  reviewed head `56801417f13e52b43735b858d42f2155f932a92c`, final-head CI
  [run 38128693155](https://github.com/milkdudpoe/refund-reconciler/actions/runs/38128693155)
  (success).
- **Landed on `main`:** merged by the owner at 2026-10-11T18:39:02Z as merge
  commit **`45520db72f8ca7d587138f695b23aac514d02529`** (parents `5b9518d`
  and `5680141`). `git diff 5680141 45520db` is empty: the merge tree is
  identical to the reviewed head. Main CI on `45520db`:
  [run 38164699785](https://github.com/milkdudpoe/refund-reconciler/actions/runs/38164699785)
  (success).
- **Date alignment:** none needed. The deployment succeeded on the reviewed
  candidate day, so no date-only PR was made.

## Pages configuration

- Before Task 15: `has_pages: false`.
- The owner set **Settings → Pages → Build and deployment → Source** to
  **GitHub Actions** (the Claude Code session could not change Pages
  settings: its `gh` token was invalid and its GitHub tools have no Pages
  settings call). No branch or `/docs` publishing, custom domain, CNAME or
  DNS change. No environment protection rule was added or changed by
  Claude Code.

## Deployment

| Field | Value |
| --- | --- |
| Workflow | *Publisher site (manual Pages deployment)*, `.github/workflows/publisher-site-pages.yml` |
| Run | [38194891795](https://github.com/milkdudpoe/refund-reconciler/actions/runs/38194891795), attempt 1, `workflow_dispatch` on `main` |
| Dispatched / checked-out commit | `45520db72f8ca7d587138f695b23aac514d02529` (verified on `main` immediately before dispatch at 2026-10-12T02:12:36Z) |
| Build job | success (typecheck, lint, `npm test`, `site:publication-check`, staging with provenance) |
| Deploy job | success; `actions/deploy-pages@v4` created the Pages deployment for `45520db` and logged *Reported success!* |
| **First publication** | **2026-10-12T02:13:31Z UTC = 2026-10-11 22:13:31 EDT (America/New_York)** |
| Environment / URL | `github-pages`, `https://milkdudpoe.github.io/refund-reconciler/` |
| Policy effective date | **2026-10-11** (equals the first-publication day in America/New_York) |

This was the first deployment of the site; no earlier Pages deployment
existed.

### Run report (artifact `refund-reconciler-publisher-site-report`, ID 11723146105)

Generated in the run itself (`generation: ci-final-head`): `sourceCommit` and
`checkoutCommit` both `45520db72f8ca7d587138f695b23aac514d02529`,
`workingTreeClean: true`, no dirty paths. Policy source
`docs/store/privacy-policy.md`, 11,134 bytes, SHA-256
`1f1be0c5972a7ab41d09c36e8f5d953eec3430f0c667994230a655ba76581a81`.
Seven files, 125,438 bytes:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 6,419 | `9fc58e2806f9e4bce74a94480e25bcc38de5ff994d82934e78ca718449e3abf6` |
| `privacy.html` | 14,309 | `933b28f603929d5d56f5218e7795314aef02fe7984af259044c69e22d6a99870` |
| `support.html` | 4,797 | `a9d4e46ce7f4fce2b5a76e06ca1ba45b97d3136c454d67057cfcea9f594b1d90` |
| `styles.css` | 7,635 | `9ba5870120695666224c3a65fe94c4dee96f5a9465870301ffd7bc0653235e85` |
| `assets/icon-32.png` | 887 | `2cbfb0aee96000ae3d2dd470c26049bee8c2c5f2b15b1df21097db9afff6a9e7` |
| `assets/icon-128.png` | 2,760 | `0cd9aa34bfcafbca38935475b8b79d48695470ab38681d4a5559e0fa081d5688` |
| `assets/example-item-evidence.png` | 88,631 | `d7d4cc6a01d486813fc0531ffef936713aea1d8377bc595b80578704676aa420` |

The run's build log prints the same `sha256sum` lines. The Pages artifact
`github-pages` (ID 11723091577) is a tar of exactly these seven entries; the
report and the beta ZIP are not in it.

## Live verification (2026-10-12T02:14Z, i.e. 2026-10-11 22:14 EDT)

Machine-readable results: [publication-verification.json](publication-verification.json).

Verified URLs:

- https://milkdudpoe.github.io/refund-reconciler/
- https://milkdudpoe.github.io/refund-reconciler/privacy.html
- https://milkdudpoe.github.io/refund-reconciler/support.html

**HTTP** (curl, content decoding on):

- All three pages, `styles.css` and the three images return **200 over
  HTTPS**; `http://` redirects (301) to `https://`.
- Every live file's decoded bytes and SHA-256 **equal the run report** above
  (7 of 7).
- `publisher-site-report.json`, the beta ZIP name, `README.md`,
  `docs/store/privacy-policy.md` and `package.json` return 404 under the
  site path: no repository files are served.

**Browser** (Chromium via Playwright, fresh contexts; 1280×900 and 375×740,
light and dark):

- Titles: *Refund Reconciler by MJUD*, *Privacy policy | Refund Reconciler*,
  *Support | Refund Reconciler*. MJUD on every page; the only mailto is
  `mailto:exiledeals@gmail.com` (inspected, not opened).
- Privacy page shows the full policy with **Effective date: 2026-10-11** and
  **Host: GitHub Pages**. No `[PENDING`, draft, *not yet effective* or
  *Prepared for review* text on any page.
- The homepage keeps the accurate extension status (*Unpublished beta*, not
  in the Chrome Web Store) and the *Synthetic* example label; these describe
  the extension, not the website.
- The homepage has two links to `privacy.html#chrome-web-store-user-data-policy`;
  clicking one lands on the `H2` *Chrome Web Store User Data Policy*, in the
  viewport.
- Header/footer navigation targets all return 200; all images load.
- No horizontal overflow at either width in either theme. The first Tab
  focuses *Skip to content* with a visible 3 px solid outline. Activating it
  moves to `#main`; focus then reports `BODY` because `<main>` has no
  `tabindex` (reviewed markup, unchanged).
- **No external requests** were made while loading any page. No scripts,
  forms or iframes. The only off-site links are the GitHub Privacy Statement
  and Chrome's Limited Use page, as reviewed.

Limitations: one browser engine (Chromium) and automated checks only; no
screen reader, no other browsers. The beta ZIP's absence was checked by
artifact contents and a 404 probe of its name.

## Still pending (not established by publication)

- Entering the policy URL in the Developer Dashboard, the actual dashboard
  privacy labels, certifications and distribution choices.
- The owner-operated **0.8.0** toolbar check.
- Real refund wording.
- Submission and Google's review. No store listing, asset upload,
  extension change or email was made.

This record's PR is a documentation change only; its head is **not** the
deployed commit (`45520db`), and merging it does not trigger a deployment
(the Pages workflow is `workflow_dispatch` only).
