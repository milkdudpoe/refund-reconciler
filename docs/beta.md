# Beta 0.6.0: build, install and check

Refund Reconciler 0.6.0 is a **local beta preview**. It runs only in your own
Chrome profile, has no account or server, and is not published in the Chrome
Web Store. This page is in two parts:

- [For developers: build the beta package](#for-developers-build-the-beta-package)
- [For testers: install and try the beta](#for-testers-install-and-try-the-beta)

followed by the [manual checks still to do](#manual-checks-still-to-do) and
[what the beta does with your data](#what-the-beta-does-with-your-data).

## For developers: build the beta package

Requirements are the same as for development (Node.js 22.12+, see `.nvmrc`;
`npm ci`). The package command works on Windows, macOS and Linux: it uses
only Node and the repository's pinned dev dependencies, no shell tools and no
extra ZIP library.

```sh
npm ci
npm run package:beta   # fresh production build + verified ZIP
npm run test:package   # the above, then load the extracted ZIP in Chromium and run a smoke test
```

Output, in the git-ignored `artifacts/beta/` folder:

| File | What it is |
| --- | --- |
| `refund-reconciler-beta-0.6.0.zip` | The installable extension. `manifest.json` is at the ZIP root. |
| `refund-reconciler-beta-0.6.0.zip.sha256` | SHA-256 checksum, in `sha256sum -c` format. |
| `refund-reconciler-beta-0.6.0.report.json` | Version, source commit, Node version, permissions, icons, and every file with its size and SHA-256. |

The checksum and report sit next to the ZIP and are not inside it.

What `npm run package:beta` does (`scripts/package-beta.ts`):

1. Checks that `package.json` and `public/manifest.json` have the same
   version, then removes only those three named output files from an earlier
   run (nothing else is deleted, and nothing outside `artifacts/beta/` is
   written).
2. Runs a fresh `vite build` into `dist/`.
3. Selects the production files explicitly: every file in `dist/` must be a
   regular file (no symlinks) matching the production allowlist (pages,
   entry scripts, `chunks/*.js`, `assets/*.css`, `icons/icon-*.png`,
   `manifest.json`). Anything else, such as a log, `.env` or a stray folder,
   fails packaging instead of being skipped.
4. Checks the extension: manifest version 3, version 0.6.0, name and
   beta/preview positioning, a description of at most 132 characters, exactly
   the `storage`, `activeTab` and `scripting` permissions, no other manifest
   keys (so no host permissions or content scripts), PNG icons of the declared
   pixel sizes, that every page, script, style and icon the manifest, HTML,
   JavaScript and CSS refer to exists, that every packaged file is referenced,
   and that no browser-test text (fixture host names, "TEST COPY", source maps)
   is present.
5. Writes the ZIP under a temporary name, **reads the archive back from
   disk**, and checks it entry by entry: safe relative paths only, regular
   files only, no duplicates or directories, exactly the selected files, each
   byte-identical to the build, then step 4 again on the archive's own
   contents. Only then is it renamed to its final name, so a failed run never
   leaves an archive that looks successful.
6. Writes the checksum and report.

The ZIP is reproducible: entries are sorted, timestamps and permissions are
fixed, so the same source gives a byte-identical archive and checksum.

`npm run test:package` (`tests/package/beta-archive.spec.ts`) then extracts
the real ZIP into a new temporary folder and loads **that extracted folder**
(not `dist/`) in Playwright's Chromium with a new, empty profile. It checks
the checksum file, the loaded manifest, version, permissions and icon sizes,
opens the dashboard and the guide, loads and removes the synthetic demo,
creates a case, confirms a receipt, inspects the stored data, downloads a
JSON backup and compares it with the stored data, and opens the popup.

**CI.** Every pull request and push to `main` runs the full checks, then
`npm run test:package`, then cross-checks the archive with `sha256sum -c`
and `unzip -l`. After all of that passes, the ZIP, checksum and report are
saved as the workflow artifact **`refund-reconciler-beta`** (kept 14 days).
GitHub delivers a workflow artifact as its own ZIP, so unzip the download once
to get `refund-reconciler-beta-0.6.0.zip` and its checksum. This is a build
artifact for manual testing, not a release or a Web Store upload. In CI the
report's `sourceCommit` is the pull request's head commit; `checkoutCommit`
is the merge commit GitHub actually built.

**Icons.** `assets-src/icon.svg` (32/48/128 px) and `assets-src/icon-16.svg`
(simplified for 16 px) are the editable sources. `npm run icons` renders them
with Playwright's bundled Chromium into `public/icons/icon-{16,32,48,128}.png`,
which are committed; the build only copies them.

## For testers: install and try the beta

You need desktop Chrome (version 120 or newer). You do not need Node.js or any
developer tools.

### Install

1. Get `refund-reconciler-beta-0.6.0.zip` from the person who built it.
   Optionally compare its SHA-256 with the `.sha256` file
   (Windows PowerShell: `Get-FileHash refund-reconciler-beta-0.6.0.zip`;
   macOS: `shasum -a 256 refund-reconciler-beta-0.6.0.zip`).
2. **Unzip it into a folder you will keep**, for example
   `Documents/Refund Reconciler beta`. Chrome runs the extension from this
   folder, so don't delete or move it afterwards. The right folder is the one
   that directly contains `manifest.json` (plus `dashboard.html`,
   `popup.html` and an `icons` folder).
3. Open `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose that folder (the one containing
   `manifest.json`, not a folder above it and not the ZIP file).
5. Click the puzzle-piece icon in the toolbar and pin **Refund Reconciler**.
   Click its icon, then **Open dashboard**. **How to use Refund Reconciler**
   at the top of the dashboard (also linked from the toolbar panel) explains
   the workflow.

Chrome may show a banner about developer-mode extensions; that is expected
for an extension loaded this way.

### Try it

- **Explore with made-up data:** at the bottom of the dashboard, **Load
  synthetic demo** adds clearly labelled example cases that are not real
  orders and are never counted in your totals. Open one to see items,
  evidence and the timeline. **Remove synthetic demo** deletes them again.
- **Your own case:** **Create case**, enter an order reference if you like,
  and add each returned item with the refund you expect (or tick
  **Unknown**). Open an item and use **Record merchant report** for what the
  merchant says it issued, **Confirm money received** only after you have
  checked your card or bank statement yourself, and **Record recharge** if
  money is taken back. Mistakes are corrected with **Void…**; the original
  and the void both stay in the history.
- **Follow up:** the overview and the **Needs attention** / **Needs review**
  filters show what is unresolved. In a case, **Prepare case summary…** gives
  text you can copy or download and share yourself.

### Back up, restore and update

- **Back up:** **Your data → Download all data (JSON)…** saves every case as
  an ordinary, **unencrypted** JSON file. Keep it somewhere private.
- **Restore:** **Restore from JSON…** reads such a file, shows a preview, and
  restores it only into a dashboard with **no cases** (delete demo cases
  first). It never merges with or overwrites existing cases.
- **Update to a newer beta:** download a backup first. Then replace the
  contents of the **same folder** with the new ZIP's contents and press the
  reload icon on the Refund Reconciler card in `chrome://extensions`. Your
  saved cases stay, because Chrome keeps data for the same installation.
  Do **not** click **Remove** to update: removing the extension deletes all
  of its saved data. Loading the new version from a *different* folder
  creates a separate installation that starts empty (and the old one keeps
  the old data until you remove it).

## Manual checks still to do

These two checks need a person using real desktop Chrome. They are **not
yet performed**; nothing in this repository claims otherwise.

What automated testing does and does not show:

- **Synthetic fixture tests** (`npm run test:e2e`) show that supported refund
  wording is parsed and the capture flow works under test conditions. They
  use hand-written pages and a temporary test copy with fixture-only host
  access, because a real toolbar click cannot be automated.
- **The extracted-ZIP smoke test** (`npm run test:package`) shows that the
  packaged extension loads from the archive and its local workflow works.
- **Neither** shows that a real toolbar click grants page access, or that
  today's Amazon wording is recognised. Opening the popup page directly in a
  tab is not a toolbar click either.

Record results only for yourself, for example in a note:

| Date | Chrome version | Check | Result (pass / fail / not run) | General reason |
| --- | --- | --- | --- | --- |
| | | Toolbar grant | | |
| | | Real Amazon refund line (optional) | | |

Write a general reason only (for example "preview said no issued amount was
found"). Do not record or send the selected text, order numbers, screenshots
of orders, bank statements, backups or anything else private. The extension
has no telemetry and submits nothing.

### Check 1: the actual toolbar grant (no account or private data needed)

1. Install the beta as above and pin its icon.
2. In a normal tab, open the public `https://www.amazon.com` home page (no
   need to sign in). Highlight a short piece of ordinary text, such as a
   product name.
3. Click the **Refund Reconciler toolbar icon** (not a bookmark or a tab with
   `popup.html`), then **Capture selected refund text**.
4. **Pass:** the panel shows **Cannot propose a report from this selection**
   with a reason such as "No amount is clearly described as issued or
   refunded" (or, if the highlight was lost, "No text is selected"). This
   means the click gave the extension temporary access and it read your
   selection. Choose **Discard**; nothing was saved.
5. **Fail:** the panel says **Refund Reconciler has no access to this tab**
   even though you clicked the toolbar icon while that tab was active.
6. Optional control: do the same on `https://example.com`. Expected: "Only
   pages on amazon.com or www.amazon.com are supported", which shows the page
   address was visible to the extension after the click.

### Check 2 (optional): one real refund line from your own order

Only if you have a real Amazon US return with a refund shown for one item.

1. Create a case for that order in the dashboard (or use **Discard** at the
   end to save nothing).
2. On your own order or refund page on `https://www.amazon.com`, highlight
   **only the refund line for one item** (for example the line saying the
   refund was issued and its amount). Do not select the whole page.
3. Click the toolbar icon, then **Capture selected refund text**.
4. **Pass:** the preview shows the same issued amount as the page. Then
   either choose the case and item and **Save merchant report**, or
   **Discard**.
5. **Fail:** the preview shows a different amount, or says it cannot propose
   a report although the line clearly states an issued refund for one item.
   Note the general reason shown, and enter the report manually instead.

Do not broaden permissions, edit the extension or change parser rules to
make a check pass. A failure is useful information for the next milestone.

## What the beta does with your data

This describes how the beta actually behaves. It is not a legal
certification or a Web Store review.

- **Permissions:** exactly three.
  - `storage`: saves your cases in this Chrome profile (`chrome.storage.local`).
  - `activeTab`: when you click the toolbar icon, Chrome gives temporary
    access to that one tab, ending when you leave the page.
  - `scripting`: after you choose Capture, runs one bundled function in that
    tab to read the text you highlighted and the page address.
  There are no host permissions, no content scripts and no background page
  scanning.
- **Capture reads only your selection** (at most 4,000 characters) and the
  page address, and only after you click the toolbar icon and choose Capture.
  Page HTML, cookies, screenshots and anything you didn't select are never
  read. Nothing is stored until you approve the preview, and only
  `amazon.com` / `www.amazon.com` pages are accepted.
- **Payments are confirmed by you.** The extension never contacts Amazon,
  your bank or anyone else. A merchant report is the merchant's statement,
  not proof of payment.
- **No network, analytics or accounts.** All code is bundled in the package;
  it makes no network requests, loads no remote code and has no sign-in.
- **Storage is local and unencrypted.** Anyone with access to your Chrome
  profile can read it. It is not synced.
- **Backups and summaries are plain files.** They are created only when you
  click Copy or Download, are not encrypted, and the extension cannot track
  or delete them.
- **Deleting:** **Delete case…** removes a case and all its evidence;
  **Remove synthetic demo** removes only demo cases. If saved data ever
  becomes unreadable, **Erase stored data…** removes all private evidence and
  leaves only an empty ledger with a random, non-private marker that stops an
  old restore approval being reused. Removing the extension from Chrome
  deletes all of its saved data.

Details: [capture.md](capture.md), [export.md](export.md),
[restore.md](restore.md) and the README's *Permissions and data* section.
