# Beta 0.6.0 validation record

What has and has not been checked for the 0.6.0 beta. Synthetic data only;
no private data, browser profiles or backups are kept in this repository.
This is not commercial validation or Chrome Web Store approval.

## Task 07 (2026-10-10)

- **Checked head:** the Task 07 branch (`task-07-beta-validation`) on top of
  `main` at `ae41a35` (merge of PR #6, Task 06 reviewed head `c7ac5d2`). The
  exact commit and CI run are in the Task 07 pull request; the CI workflow
  artifact's `report.json` names its `sourceCommit`.
- **Runtime:** unchanged from Task 06 (no source, manifest or version change).
- **Environments:** all with Node 22.22.0, Playwright 1.56.1 and
  **bundled Chromium 141.0.7390.37** (not installed desktop Chrome).
  - Linux cloud container (local runs), LF checkout.
  - CI `ubuntu-latest`: the full suite and the beta artifact.
  - CI `windows-latest` (Windows Server 2025): a CRLF checkout (asserted in
    the job), unit tests and the full update check.

### Automated (pass)

| Check | Linux (local and CI) | Windows CI (CRLF) |
| --- | --- | --- |
| Typecheck, lint | pass | not run in this job |
| Unit tests (`npm test`) | 320 passed | 319 passed, **1 skipped** (the existing symlink test, which is skipped on Windows) |
| Browser suite (`npm run test:e2e`) | 87 passed | not run in this job (the owner reports it passes on Windows) |
| Extracted-ZIP smoke test (`npm run test:package`) | 1 passed | not run in this job (the owner reports it passes on Windows) |
| Same-installation update 0.5.0 → 0.6.0 (`npm run test:update`) | 1 passed | 1 passed |

**Task 07.1 (Windows fixes).** The first version of the update check failed
on Windows, so the test harness was corrected; the extension itself did not
change.

- The workflow-wiring unit test now compares logical lines, so a CRLF
  checkout passes. It checks both LF and CRLF forms.
- Developer mode is now switched on through the test profile's own
  `chrome://extensions` switch, and checked on a reloaded extensions page.
  Before, the check wrote it into the `Preferences` file, which Windows
  ignores, so the reload disabled the extension.
- Every browser session is closed before the temp folder is removed, even
  when the test fails.

**Failure-path cleanup check** (Linux, using temporary edits that were not
committed):

- (a) Developer mode left off, reproducing the Windows reload timeout.
- (b) An assertion failure while the main browser was open, after the
  update.
- (c) An assertion failure while the recovery browser was open.

Each run reported only its own original error, removed its temp work folder,
and left no Chromium process running. Windows CI shows the passing run on
Windows. The failure-path check itself was run on Linux only.

The update check is described in
[beta.md](beta.md#update-check-050-to-this-beta-in-the-same-installation).
In short, in bundled Chromium: 0.5.0 built from its own source
(`b323930`) was loaded from one temp folder, populated with a rich synthetic
ledger, and updated in place to the extracted beta ZIP with an **extension
reload** (`chrome.runtime.reload()`): the loaded version changed to 0.6.0,
the extension ID stayed the same, and the stored ledger, the calculated
case states, the JSON backup and the data after a **full browser restart**
all matched 0.5.0 exactly. The backup restored into a separate empty profile,
and restoring it into the populated installation was refused without
changes.

Packaging was repeated several times on Linux and gave the same ZIP SHA-256
each time (`ec728690…`, matching the Ubuntu CI artifact). The Windows CI job's
CRLF build produced a different ZIP (`8551b574…`), as beta.md explains.
Check a ZIP only against the checksum that came with it.

### Manual

| Check | Result | Note |
| --- | --- | --- |
| Toolbar grant on public amazon.com (desktop Chrome) | **not run** | No real desktop Chrome toolbar was available in the environment used. Owner checklist below. |
| Real Amazon refund line (optional) | **not run** | Needs the owner's own suitable order; no access was available or requested. |
| Update in place through the `chrome://extensions` UI (optional) | **not run** | Automated check covers reload and restart in bundled Chromium only. |

## Still outstanding (owner)

**Toolbar grant** (needs desktop Chrome, no account; see
[beta.md, Check 1](beta.md#check-1-the-actual-toolbar-grant-no-account-or-private-data-needed)):

1. New, temporary Chrome profile. `chrome://extensions` → Developer mode →
   **Load unpacked** the extracted CI beta ZIP (check it against the
   `.sha256` that came with it). Pin the icon.
2. Open `https://www.amazon.com` (not signed in). Highlight a short piece of
   ordinary text.
3. Click the toolbar icon → **Capture selected refund text**.
4. Pass: **Cannot propose a report from this selection** → **Discard**.
   **No text is selected** → close the panel, highlight again, retry once;
   still the same → inconclusive. **No access to this tab** → fail.
   Anything else → fail or inconclusive.
5. Optional: same on `https://example.com` → "Only pages on amazon.com or
   www.amazon.com are supported".
6. Open the dashboard and confirm no case or entry was added.

Record only: date, Chrome version, the ZIP's version and source commit (from
its `report.json`), method ("toolbar click"), general outcome and
pass / fail / inconclusive.
