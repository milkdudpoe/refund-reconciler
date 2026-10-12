# Store submission handoff (Task 16, beta 0.8.0)

The short entry point for submitting Refund Reconciler's first **unlisted
free beta** to the Chrome Web Store. The owner chose that distribution. This
page and the handoff archive **prepare** the submission; the owner uploads,
declares and submits.

## Status

| Stage | State |
| --- | --- |
| **Prepared** | **Yes.** Tested ZIP, listing images, paste-ready text and owner steps, in one CI artifact |
| Uploaded | No |
| Submitted | No |
| Approved (Google's review) | No. Review happens *after* submission; it is not a step before it |
| Published | No. The website keeps its "not in the Chrome Web Store" status until a separate release task |

Pending before the owner submits (owner actions, not code):

1. The **0.8.0 desktop Chrome check**: **not run.** The 0.6.0 result does
   not cover it. Steps and reply template: `OWNER-START-HERE.md` in the
   handoff ([template](handoff/OWNER-START-HERE.md#desktop-chrome-check-version)).
2. An explicit owner decision on submitting with **real Amazon refund
   wording untested** (only example text has been tested; the listing and
   reviewer text say so).
3. Developer account setup (not inspected), the dashboard's privacy
   data-type mapping and the certifications: the owner's own declarations,
   made after reading the dashboard's definitions
   ([privacy answers](handoff/privacy-and-permissions.md)).
4. Confirming the recommended **category (Productivity)** and **regions
   (United States)**. These are recommendations, not owner choices yet.

## Get the handoff

```sh
npm run package:beta                      # or: npm run test:package
npm run assets:store -- --reuse-package   # listing images from that ZIP
npm run store:handoff                     # bundles both; builds nothing
```

`npm run store:handoff` (`scripts/store-handoff.ts`,
`scripts/handoff/inputs.ts`) reads the existing outputs and refuses to
assemble if any is missing, changed or inconsistent:

- the ZIP must be the tested package, `refund-reconciler-beta-0.8.0.zip`,
  85,563 bytes, SHA-256
  `79cc8f5ebae2780723ab4b4ba84b9d6a64f0462548b523476a3a46eb8365bfd8`, and
  agree with its `.sha256` and its report (version, name, permissions and
  every file's size and hash);
- it must still pass the production allowlist and manifest checks
  (`scripts/beta/verify.ts`);
- the reports must name this checkout (and in CI this run's source commit);
- the store images must come from that same ZIP (report and capture
  record), in the documented order and sizes, with matching hashes.

CI runs it in the Ubuntu job after the package, update and store-asset
checks, extracts the result again, checks every inventory hash, compares the
bundled ZIP byte for byte with the built one, and uploads the artifact
**`refund-reconciler-store-handoff`** (14 days): the outer archive, its
`.sha256` and `store-handoff-report.json`. The existing `refund-reconciler-beta`,
`refund-reconciler-store-assets` and `refund-reconciler-publisher-site`
artifacts are unchanged.

### What the archive contains

`refund-reconciler-store-handoff-0.8.0.zip` is a folder for a person, **not
an extension** (no `manifest.json` at its root). Only
`extension/refund-reconciler-beta-0.8.0.zip` inside it is uploaded.

| Path | Source |
| --- | --- |
| `OWNER-START-HERE.md` | [handoff/OWNER-START-HERE.md](handoff/OWNER-START-HERE.md) |
| `listing-description.txt` | The approved detailed description in [listing.md](listing.md#detailed-description), markdown marks removed |
| `reviewer-instructions.txt` | [handoff/reviewer-instructions.txt](handoff/reviewer-instructions.txt) |
| `privacy-and-permissions.md` | [handoff/privacy-and-permissions.md](handoff/privacy-and-permissions.md), answers quoted from [privacy-practices.md](privacy-practices.md) |
| `extension/` | The beta ZIP with its `.sha256` and report, unchanged |
| `images/` | `icon-128.png` (extracted from the ZIP), the 440×280 tile and three 1280×800 screenshots from the same run, `store-assets-report.json`, and `README.txt` with the order and captions from [assets.md](assets.md#recommended-order-and-captions) |
| `inventory.json` | Bytes, SHA-256 and source of every file **except itself**, plus generation, source/checkout commit and CI run |

The outer archive's own SHA-256 is in the `.sha256` file beside it and in
`store-handoff-report.json`, never inside the archive. Nothing in it
contains browser profiles, passphrases, tokens, machine paths or signed
links (the script refuses machine paths and link-signature text).

**Which copy is which.** The files in `docs/store/handoff/` are committed
templates. The archive in the CI artifact for a given head is the generated
final-head output (`generation: ci-final-head`); a local run is labelled
`local`.

## Metadata: from the ZIP vs. dashboard fields

The name **Refund Reconciler (local preview)**, the 127-character manifest
description, version 0.8.0, icon and permissions come from the ZIP and
cannot be edited in the dashboard without a new ZIP and version
([Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)).
They stay unchanged in this task. The detailed description, category,
language, images, URLs, privacy answers, distribution and test instructions
are dashboard fields. The shorter summary drafted in [listing.md](listing.md)
is not used.

## Chrome documentation checked (2026-10-12)

Derived guidance in the handoff cites these pages. They describe the
dashboard in general; the owner's account screens were **not** seen.

| Page (footer date) | Used for |
| --- | --- |
| [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish) (2014-02-28) | Add new item → upload ZIP; Package, Store listing, Privacy, Distribution, Test instructions tabs; Submit for review; deferred publishing with 30 days to publish after approval |
| [Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) (2020-12-07) | Description, category, language, 128 px icon, 1280×800 screenshots, 440×280 tile; homepage and support URLs; Official URL only for verified sites |
| [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) (2020-06-12) | Single purpose, permission justifications, remote code, data usage, certifications, policy URL. Data-type labels appear only as a screenshot |
| [Distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) (2020-12-07) | Unlisted: no listing, installable by link; the same policy requirements and review as public; regions |
| [Test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions) (2025-05-16) | Optional; meant for restricted credentials, which this extension does not need |
| [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare) (2023-10-16) | Name, description, icons and version come from the manifest |

## Verification (Task 16)

- Local precommit probe (Linux container, working tree with these changes
  uncommitted, so labelled `local`): `npm run package:beta` reproduced the
  tested ZIP hash; `assets:store -- --reuse-package` and `store:handoff`
  assembled a 15-entry archive; an independent Python extraction matched
  every inventory hash, the inner ZIP hash and allowlist, manifest version
  and permissions, image sizes and the icon's identity with the packaged
  icon. Twelve refusal probes (missing ZIP, report or screenshot; changed
  ZIP bytes; wrong `.sha256`; changed report version, checkout or file
  hash; images, capture record or report label from another source) all
  exited 1 with a clear message. `tests/unit/store-handoff.test.ts` keeps
  ten of these refusals in the unit suite.
- The final-head record is the CI run on the pull request head and its
  `refund-reconciler-store-handoff` artifact (named in the PR).

## The ZIP is not served by the website

Task 15's [verification JSON](publication-verification.json) probed the
name `refund-reconciler.zip` (404). The independent review of Task 15 also
probed the actual `refund-reconciler-beta-0.8.0.zip` under the site path and
got 404. The historical JSON is left as recorded.

## Related

[listing.md](listing.md) · [privacy-practices.md](privacy-practices.md) ·
[assets.md](assets.md) · [publication.md](publication.md) ·
[readiness.md](readiness.md) · [../beta.md](../beta.md#manual-checks)
