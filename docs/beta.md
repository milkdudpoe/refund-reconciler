# Beta 0.8.0: build, install and check

Refund Reconciler 0.8.0 is a **local beta preview**. It runs only in your own
Chrome profile, has no account or server, and is not published in the Chrome
Web Store. From 0.8.0 the dashboard explains how the extension handles your
data and asks for **Agree and continue** before any data feature
([consent.md](consent.md)). Since 0.7.0 the saved ledger is encrypted with a
passphrase you choose ([vault.md](vault.md)); there is no recovery service.
This page is in two parts:

- [For developers: build the beta package](#for-developers-build-the-beta-package)
- [For testers: install and try the beta](#for-testers-install-and-try-the-beta)

followed by the [manual checks](#manual-checks) and
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
npm run test:update    # the above packaging, then update 0.5.0, 0.6.0 and 0.7.0 in place to this ZIP (see below)
```

Output, in the git-ignored `artifacts/beta/` folder:

| File | What it is |
| --- | --- |
| `refund-reconciler-beta-0.8.0.zip` | The installable extension. `manifest.json` is at the ZIP root. |
| `refund-reconciler-beta-0.8.0.zip.sha256` | SHA-256 checksum, in `sha256sum -c` format. |
| `refund-reconciler-beta-0.8.0.report.json` | Version, source commit, Node version, permissions, icons, and every file with its size and SHA-256. |

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
4. Checks the extension: manifest version 3, version 0.8.0, name and
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

**Reproducibility, and which checksum to trust.** The ZIP itself is
deterministic: entries are sorted and timestamps and permissions are fixed,
so identical build output always gives a byte-identical archive, and
repeated builds in the same environment match. The *build output* can still
differ between environments: a Windows checkout with CRLF line endings and a
Linux checkout with LF endings at the same commit currently produce
different CSS bytes and therefore different hashed file names. So the source
commit alone does not guarantee the CI checksum. Check a ZIP only against the
`.sha256` file that came with **that exact ZIP**.

`npm run test:package` (`tests/package/beta-archive.spec.ts`) then extracts
the real ZIP into a new temporary folder and loads **that extracted folder**
(not `dist/`) in Playwright's Chromium with a new, empty profile. It checks
the checksum file, the loaded manifest, version, permissions and icon sizes,
checks that the data practices come first (nothing stored, the popup only
offers the dashboard), agrees, completes **Protect your records**, checks
that only the consent receipt and the encrypted vault are stored, rereads
**Data and privacy**, opens the guide, loads and removes the synthetic demo,
creates a case, confirms a receipt, inspects the stored data
(decrypted by a test-side decoder) and that no plaintext is in storage,
downloads a JSON backup and compares it with the stored data, uses **Lock
now** and unlocks again, and opens the popup.

### Update checks: 0.5.0, 0.6.0 and 0.7.0 to this beta in the same installation

`npm run test:update` (`tests/update/`, also run in CI) checks that updating
each earlier production version in place requires the new agreement first,
keeps a tester's data, and migrates a plaintext ledger into the encrypted
vault (or keeps the 0.7.0 vault and passphrase as they are). It uses only folders and profiles it creates
under the system temp directory, removes them afterwards, and uses synthetic
data. It runs once per baseline:

| Baseline | Commit | What it is |
| --- | --- | --- |
| 0.5.0 | `b323930f7d9580f426e7e8fee39b4242143c4844` | merged Task 05 |
| 0.6.0 | `60e330b12d195908a44ad341a73e34678a5a697d` | Task 07.1 head, the last plaintext version |
| 0.7.0 | `da475840933b21eab85553e8b2ad54c3e049bf90` | Task 09.1 head, the encrypted ledger before the agreement step |

1. **Baseline from its own source.** `git archive` exports the commit into
   the temp folder; the repository's working tree, index and HEAD are not
   touched. The commit must be in the local repository (any full clone has
   it; CI runs `git fetch --no-tags --depth=1 origin <commit>` for each
   baseline first, and the check prints that command if one is missing). The
   baseline then runs `npm ci` from its own lockfile (scripts disabled) and
   its own `vite build`.
2. **The baseline in a fresh profile**, loaded from one stable temp folder.
   The check switches on **Developer mode** with that profile's own
   `chrome://extensions` switch (only if it is off) and confirms it is on
   after reloading that page; Chromium refuses to reload an unpacked
   extension without it, and a value written into the profile's
   `Preferences` file is not applied on Windows. The check confirms the
   loaded version, then populates it: for 0.5.0/0.6.0 it writes a
   deliberately unreadable value to the plaintext key only to reach the
   baseline's **Erase stored data…** control (giving an erase marker); 0.7.0
   is first protected with a synthetic passphrase in its own UI, locked, and
   erased from its own locked screen, then protected again. It then restores the synthetic rich
   ledger (`tests/shared/rich-ledger.ts`: two real and two demo cases,
   partial receipt, recharges, a void, an unknown expectation, current and
   historical captures) through the baseline's own **Restore from JSON…**,
   and creates one more case entirely in the baseline's UI (merchant report,
   partial receipt, recharge and its void, an unknown item; for 0.7.0 a
   merchant report, partial receipt and an unknown item). It reads the
   ledger back (decrypted by the test-side decoder for 0.7.0), validates it, compares it with the baseline's own
   **Download JSON** (kept as a real earlier-version backup), and records
   what the baseline's dashboard shows.
3. **Update in place.** It extracts the real beta ZIP into a separate
   folder, replaces the files in the **same** installed folder with it, and
   reloads the extension with `chrome.runtime.reload()`. The loaded manifest
   must now be 0.8.0 with the **same extension ID** and exactly the three
   permissions.
4. **Agreement first.** The dashboard shows **How Refund Reconciler handles
   your data**, with no passphrase field; storage is byte-for-byte what the
   baseline left; the popup only offers the dashboard; a direct migrate (or,
   for 0.7.0, unlock) request is refused with `consent_required`; **Not now**
   and a reload change nothing. Then **Agree and continue** through the UI
   stores only the nonprivate receipt.
5. **0.5.0/0.6.0 migration.** The dashboard shows **Protect your existing records**;
   the records still hold exactly the plaintext snapshot. **Download plaintext
   backup (JSON)** gives exactly that ledger and changes nothing. The check
   then migrates through the real UI. A read-only recorder in the service
   worker confirms the order: migration marker, candidate vault, read-back,
   verified marker, and only then removal of the plaintext key and the
   marker. Afterwards only the vault key is stored, its decrypted ledger
   equals the snapshot exactly (every ID, date, note, reference, demo flag,
   capture provenance and parser version, void, `revision`, `lastRestore`
   receipt and `ledgerEpoch`), no private text is readable in storage,
   historical captures are not re-parsed, and the dashboard shows the same
   overview, case rows, summaries, items and timelines as the baseline did.
   **0.7.0 unlock.** The dashboard shows the locked screen (never setup); the
   0.7.0 passphrase unlocks the same vault; the stored ciphertext, erase
   marker and absence of a plaintext key are unchanged, and the decrypted
   ledger and dashboard equal the baseline's.
6. **Full browser restart** with the same profile and folder: same ID,
   version 0.8.0, the agreement still in place (no disclosure screen),
   **locked until the passphrase is entered**, then the same
   data and dashboard. The current **Download JSON** contains the same
   ledger. Restoring the backup into this populated installation is refused
   and changes nothing. One new entry continues the same history, encrypted.
7. **Recovery:** the **baseline's own backup** is restored into a separate,
   empty profile running the extracted ZIP, after **Agree and continue** and
   **Protect your records**; restore neither imports nor implies agreement;
   its cases equal the original exactly, the destination keeps its own erase
   marker, and its dashboard shows the same states.

What this does **not** cover: it runs in Playwright's bundled Chromium, not
installed desktop Chrome; the extension is loaded with `--load-extension`
and reloaded with `chrome.runtime.reload()`, which is not the same as Chrome's
**Load unpacked** registration or the reload icon in `chrome://extensions`;
and the "restart" relaunches the browser with the same command-line folder.
The manual [Check 3](#check-3-optional-update-in-place-in-chrome) covers the
Chrome UI path. It does not show that old plaintext bytes disappear from
Chrome's database files (they may not). Nothing is added to the production
package for this check.

Every browser the check starts is closed after the test, also when it fails
(including a failed launch or a reload that never finishes), before its temp
folder is removed, so a failure is reported as itself rather than as a
locked-file error. Set `KEEP_UPDATE_CHECK_FILES=1` to keep the temp folder
for inspection. CI runs the check on Ubuntu and on Windows (`windows-latest`,
CRLF checkout, together with the unit tests).

**CI.** Every pull request and push to `main` runs the full checks, then
`npm run test:package`, then fetches the 0.5.0, 0.6.0 and 0.7.0 baseline commits and
runs `npm run test:update`, then cross-checks the archive with `sha256sum -c`
and `unzip -l`. After all of that passes, the ZIP, checksum and report are
saved as the workflow artifact **`refund-reconciler-beta`** (kept 14 days).
GitHub delivers a workflow artifact as its own ZIP, so unzip the download once
to get `refund-reconciler-beta-0.8.0.zip` and its checksum. This is a build
artifact for manual testing, not a release or a Web Store upload. In CI the
report's `sourceCommit` is the pull request's head commit; `checkoutCommit`
is the merge commit GitHub actually built.

**Icons.** `assets-src/icon.svg` (32/48 px), `assets-src/icon-16.svg`
(simplified for 16 px) and `assets-src/icon-store.svg` (128 px, the same
artwork as a 96×96 tile with 16 px transparent padding, as the Chrome Web
Store asks; Task 11) are the editable sources. `npm run icons` renders them
with Playwright's bundled Chromium into `public/icons/icon-{16,32,48,128}.png`,
which are committed; the build only copies them.

**Store listing images** (not part of the ZIP): `npm run assets:store`
captures them from this ZIP; CI also uploads them as the separate
**`refund-reconciler-store-assets`** artifact. See
[store/assets.md](store/assets.md).

## For testers: install and try the beta

You need desktop Chrome (version 120 or newer). You do not need Node.js or any
developer tools.

### Install

1. Get `refund-reconciler-beta-0.8.0.zip` from the person who built it.
   Optionally compare its SHA-256 with the `.sha256` file that came with
   that same ZIP (Windows PowerShell: `Get-FileHash refund-reconciler-beta-0.8.0.zip`;
   macOS: `shasum -a 256 refund-reconciler-beta-0.8.0.zip`).
2. **Unzip it into a folder you will keep**, for example
   `Documents/Refund Reconciler beta`. Chrome runs the extension from this
   folder, so don't delete or move it afterwards. The right folder is the one
   that directly contains `manifest.json` (plus `dashboard.html`,
   `popup.html` and an `icons` folder).
3. Open `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose that folder (the one containing
   `manifest.json`, not a folder above it and not the ZIP file).
5. Click the puzzle-piece icon in the toolbar and pin **Refund Reconciler**.
   Click its icon, then **Open dashboard** (before you agree, the panel offers
   only **Open dashboard to review**). **How to use Refund Reconciler**
   at the top of the dashboard explains the workflow.
6. **Read how your data is handled:** the dashboard first shows **How Refund
   Reconciler handles your data**. Read it and choose **Agree and continue**
   to use the extension, or **Not now** (nothing is stored or changed, and
   data features stay off). You can reread it later under **Data and
   privacy** at the top of the dashboard.
7. **Protect your records:** choose a passphrase of at least 12 characters
   (a few unrelated words work well), type it twice, and tick that you
   understand it cannot be recovered. Keep it somewhere safe: without it,
   your saved records can only be erased. You will need it again after
   Chrome restarts, after the extension is reloaded or updated, and after
   **Lock now**.

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
  an ordinary, **unencrypted** JSON file. Keep it somewhere private. It is
  also your only way back if you forget the passphrase.
- **Lock:** **Lock now** (top of the dashboard) clears every open dashboard
  and the toolbar panel at once; the passphrase unlocks again.
- **Restore:** **Restore from JSON…** reads such a file, shows a preview, and
  restores it only into an unlocked dashboard with **no cases** (delete demo
  cases first). It never merges with or overwrites existing cases. Backups
  from 0.5.0 and 0.6.0 restore too.
- **Update to a newer beta:** download a backup first. Then replace the
  contents of the **same folder** with the new ZIP's contents and press the
  reload icon on the Refund Reconciler card in `chrome://extensions`. Your
  saved cases stay, because Chrome keeps data for the same installation.
  After an update you unlock again. **Updating to 0.8.0** from any earlier
  version first shows the data practices; your records are kept untouched
  until you choose **Agree and continue**. **Updating from 0.7.0:** then
  unlock with your existing passphrase. **Updating from 0.5.0 or 0.6.0:** the
  dashboard then shows **Protect your existing records**; you can download a
  plaintext backup, then choose a passphrase, and your records are encrypted
  and checked field by field before the plaintext copy is removed. Older
  plaintext may remain in Chrome's own files.
  Do **not** click **Remove** to update: removing the extension deletes all
  of its saved data. Loading the new version from a *different* folder
  creates a separate installation that starts empty (and the old one keeps
  the old data until you remove it).

## Manual checks

These checks need a person using real desktop Chrome. Current status
(details in [validation.md](validation.md)):

- **Check 1 (toolbar grant):** **not run for 0.7.0 or 0.8.0.** The popup
  changed (0.7.0: it reads nothing until the records are unlocked; 0.8.0:
  nothing before agreement either), so it needs a new owner-operated toolbar
  check. The 0.6.0 result does not cover 0.7.0 or 0.8.0. For context: 0.6.0 passed,
  **owner-reported** on 2026-10-10 in desktop Chrome 154.0.8037.98 (general
  outcome "Cannot propose a report from this selection"; dashboard stayed
  empty), not independently reproduced.
- **Check 2 (real refund line, optional):** untested.
- **Check 3 (update in place in Chrome, optional):** untested.

What automated testing does and does not show:

- **Synthetic fixture tests** (`npm run test:e2e`) show that supported refund
  wording is parsed and the capture flow works under test conditions. They
  use hand-written pages and a temporary test copy with fixture-only host
  access, because a real toolbar click cannot be automated.
- **The extracted-ZIP smoke test** (`npm run test:package`) shows that the
  packaged extension loads from the archive and its local workflow works.
- **The update checks** (`npm run test:update`) show that 0.5.0, 0.6.0 and
  0.7.0 updated in place to the beta ZIP require agreement first, keep their
  data, and (0.5.0/0.6.0) migrate it exactly into the vault or (0.7.0) keep
  the same vault and passphrase, in bundled Chromium.
- **None** shows that a real toolbar click grants page access, or that
  today's Amazon wording is recognised. Opening the popup page directly in a
  tab is not a toolbar click either. (The owner-reported Check 1 above covered
  the toolbar grant for 0.6.0 only; refund wording is still untested.)

Record results only for yourself, for example in a note:

| Date | Chrome version | Check | Result (pass / fail / inconclusive / not run) | General reason |
| --- | --- | --- | --- | --- |
| | | Toolbar grant | | |
| | | Real Amazon refund line (optional) | | |
| | | Update in place in Chrome (optional) | | |

Write a general reason only (for example "preview said no issued amount was
found"). Do not record or send the selected text, order numbers, screenshots
of orders, bank statements, backups or anything else private. The extension
has no telemetry and submits nothing.

### Check 1: the actual toolbar grant (no account or private data needed)

1. Install the beta as above and pin its icon. (Optional first, 0.8.0:
   before agreeing, click the toolbar icon on any page; the panel should
   show only **Open dashboard to review** and say nothing on the page was
   read.) Open the dashboard, read the data practices and choose **Agree and
   continue**, then complete **Protect your records** with a throwaway
   passphrase (or unlock), so the records are **unlocked**. (Optional: while
   locked, the toolbar panel should show only **Open dashboard to unlock**.)
2. In a normal tab, open the public `https://www.amazon.com` home page (no
   need to sign in). Highlight a short piece of ordinary text, such as a
   product name.
3. Click the **Refund Reconciler toolbar icon** (not a bookmark or a tab with
   `popup.html`), then **Capture selected refund text**.
4. **Pass:** the panel shows **Cannot propose a report from this selection**
   with a reason such as "No amount is clearly described as issued or
   refunded". The click gave temporary access and your selection was read
   and refused. Choose **Discard**; nothing was saved.
5. **Retry once:** if the panel instead says **No text is selected** (with
   **Try again** and **Open dashboard**, no **Discard**), access worked but
   the highlight was not kept. Close the panel by clicking the page; nothing
   was saved. Highlight the text again, click the toolbar icon and Capture
   once more. If it says the same again, record **inconclusive**.
6. **Fail:** the panel says **Refund Reconciler has no access to this tab**
   even though you clicked the toolbar icon while that tab was active.
7. **Anything else** (another message, or a preview offering to save):
   record **fail** or **inconclusive** with a general reason. Do not count it
   as a pass.
8. Optional control: do the same on `https://example.com`. Expected: "Only
   pages on amazon.com or www.amazon.com are supported" (with **Try again** /
   **Open dashboard**), which shows the page address was visible to the
   extension after the click.

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

### Check 3 (optional): update in place in Chrome

Only with a throwaway Chrome profile and made-up data, not your real cases.

1. Load the previous version's folder (0.7.0 built from commit `da47584`,
   0.6.0 from `60e330b`, or 0.5.0 from `b323930`) with **Load unpacked**,
   (0.7.0: set a throwaway passphrase), load the synthetic demo and create
   one made-up case, then download a JSON backup.
2. Replace that folder's contents with the new ZIP's contents and press the
   reload icon on the Refund Reconciler card in `chrome://extensions`.
3. **Pass:** the card shows the new version, the extension ID on the card is
   unchanged, and the dashboard first shows the data practices. After
   **Agree and continue** it shows **Protect your existing records** (0.5.0
   or 0.6.0; choose a throwaway passphrase) or the locked screen (0.7.0; your
   passphrase). It then shows the same cases, and after quitting and
   reopening Chrome it asks for the passphrase (not for agreement again) and
   then shows them again.

Do not broaden permissions, edit the extension or change parser rules to
make a check pass. A failure is useful information for the next milestone.

## What the beta does with your data

This describes how the beta actually behaves. It is not a legal
certification or a Web Store review.

- **Permissions:** exactly three.
  - `storage`: saves your encrypted cases in this Chrome profile
    (`chrome.storage.local`) and, while unlocked, the key in memory-only
    `chrome.storage.session`.
  - `activeTab`: when you click the toolbar icon, Chrome gives temporary
    access to that one tab, ending when you leave the page.
  - `scripting`: after you choose Capture, runs one bundled function in that
    tab to read the text you highlighted and the page address.
  There are no host permissions, no content scripts and no background page
  scanning.
- **You agree first.** Before any data feature, the dashboard shows how your
  data is handled and asks for **Agree and continue**; only a small
  nonprivate receipt (data-practices version and time) is stored for that.
  **Not now** changes nothing. Reread it under **Data and privacy**.
- **Capture reads only your selection** (at most 4,000 characters) and the
  page address. Only after you have agreed and while your records are
  unlocked does opening the toolbar panel see the tab's address to check that
  the page is supported (kept in memory only); the selection is read only
  after you choose Capture. Before agreement, or while locked, the panel
  reads nothing from the page.
  Page HTML, cookies, screenshots and anything you didn't select are never
  read. Nothing is stored until you approve the preview, and only
  `amazon.com` / `www.amazon.com` pages are accepted.
- **Payments are confirmed by you.** The extension never contacts Amazon,
  your bank or anyone else. A merchant report is the merchant's statement,
  not proof of payment.
- **No network, analytics or accounts.** All code is bundled in the package;
  it makes no network requests, loads no remote code and has no sign-in.
- **Storage is local and encrypted.** The saved ledger is encrypted with a
  key protected by your passphrase (PBKDF2-HMAC-SHA-256, 600,000 iterations,
  AES-256-GCM; [vault.md](vault.md)). The passphrase is never stored and
  there is no recovery service. Encryption does not protect records while
  they are unlocked, against malware on the computer, or with a weak
  passphrase, and plaintext left by 0.5.0/0.6.0 may remain in Chrome's
  files. It is not synced.
- **Backups, summaries and copied text are plaintext.** They are created only
  when you click Copy or Download while unlocked, are not encrypted, and the
  extension cannot track or delete them.
- **Deleting:** after you agree and unlock, **Delete case…** removes a case and all its evidence;
  **Remove synthetic demo** removes only demo cases. While locked (for a
  forgotten passphrase), before agreeing, or if saved data is unreadable,
  **Erase stored data…** (type `ERASE`) removes all stored records and your
  agreement, and leaves only a
  random, non-private marker that stops an old restore approval or session
  being reused. Removing the extension from Chrome
  deletes all of its saved data.

Details: [vault.md](vault.md), [capture.md](capture.md), [export.md](export.md),
[restore.md](restore.md) and the README's *Permissions and data* section.
