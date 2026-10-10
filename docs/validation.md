# Beta validation record

What has and has not been checked for the beta. Synthetic data only; no
private data, browser profiles, passphrases or backups are kept in this
repository. This is not commercial validation, evidence of customer demand
or Chrome Web Store approval.

## Current status (as of 2026-10-10, version 0.7.0)

| Check | Status | Source |
| --- | --- | --- |
| Automated suites, extracted-ZIP smoke test, same-installation updates 0.5.0 → 0.7.0 and 0.6.0 → 0.7.0 (bundled Chromium) | pass | [Task 09](#task-09-070-encrypted-ledger-2026-10-10) |
| Toolbar access on the public amazon.com home page (desktop Chrome), **0.7.0** | **not run**: the popup changed (it reads nothing until unlocked), so a new owner-operated check is needed | — |
| Toolbar access, **0.6.0** (context only) | pass, owner-reported (not independently reproduced) | [Task 08](#task-08-owner-reported-toolbar-check-reported-2026-10-10) |
| Real Amazon refund wording (optional) | **untested** | — |
| Update in place through the `chrome://extensions` UI (optional) | **untested** | — |

## Task 09: 0.7.0 encrypted ledger (2026-10-10)

- **Runtime change:** the ledger is encrypted at rest; setup, unlock, Lock
  now, typed erase and migration of 0.5.0/0.6.0 data were added
  ([vault.md](vault.md)). Version 0.7.0. Permissions unchanged (`storage`,
  `activeTab`, `scripting`).
- **Environments (local runs):** Linux cloud container (Intel Xeon 2.1 GHz,
  4 vCPU), Node 22.22.0, Playwright 1.56.1 with **bundled Chromium
  141.0.7390.37 (build 1194)**, LF checkout. CI runs on `ubuntu-latest` and
  `windows-latest` are recorded in the Task 09 pull request.

| Check | Linux (local) | Notes |
| --- | --- | --- |
| Typecheck, lint | pass | |
| Unit tests (`npm test`) | **369 passed** (was 320) | +49: envelope/crypto (10), handler rewritten for the vault (19 instead of 10), migration fault injection (31), restore/capture handler tests ported to the vault; Windows skips the existing symlink test as before |
| Browser suite (`npm run test:e2e`) | **96 passed** (was 87) | the 87 earlier tests adapted to set up/unlock through the real UI, plus 9 in `tests/e2e/vault.spec.ts` |
| Extracted-ZIP smoke test (`npm run test:package`) | 1 passed | now also sets up, locks and unlocks |
| Same-installation updates (`npm run test:update`) | **2 passed** (was 1) | 0.5.0 (`b323930`) and 0.6.0 (`60e330b`), each built from its own source and lockfile |

How the earlier browser tests were adapted (disclosed): every fresh profile
completes **Protect your records** through the real dashboard with a
synthetic passphrase (`tests/e2e/fixtures.ts` `openDashboard`); tests that
seeded storage now write vault ciphertext with an independent test-side
encoder, and read stored data with a matching decoder, using the data key
from the session record the extension wrote (`tests/e2e/vault-helpers.ts`);
page-level faults wrap only the page's own runtime messages (reads
separately from changes). Behaviour that changed on purpose is asserted as
changed, not removed: an erase in another view now closes an open restore
panel (the late reply cannot reopen it), and the popup refuses to read a
page when it cannot confirm the records are unlocked. No production test
hook or extra host grant was added; capture tests still use a temporary
test copy with fixture-only host access, as before.

KDF timing (reported, not asserted; production work factor):
Node — setup 144 ms, unlock 107 ms; bundled Chromium click-to-unlocked —
setup 416–421 ms, unlock 422 ms, both in the container above. Not measured
on users' computers.

## Task 08: owner-reported toolbar check (reported 2026-10-10)

The owner ran the toolbar check from the [checklist](#reusable-manual-toolbar-checklist)
in desktop Chrome and reported this on 2026-10-10:

```text
Chrome version: 154.0.8037.98 (Official Build) (64-bit) (cohort: Stable)
Toolbar check: pass
General outcome: Cannot propose a report from this selection
Dashboard stayed empty: yes
```

- **Status:** owner-reported. It was not independently reproduced by the
  person writing this record.
- **Date:** the report date, 2026-10-10. A separate test date and time were
  not supplied.
- **Method:** the checklist asked for an actual toolbar click on ordinary
  selected text from the public Amazon US home page, followed by Capture.
- **Not supplied, so not recorded:** operating system, profile
  configuration, the optional `example.com` control and any other
  observations.
- **Artifact context (from the checklist, not from the reply):** the
  checklist was issued for the reviewed Ubuntu CI beta 0.6.0 artifact
  built from source `60e330b12d195908a44ad341a73e34678a5a697d`, ZIP SHA-256
  `ec7286901a29ce80b564deb5314d4a6363f5b7b2e2fd5810a1e238c1a4e2d259`, CI
  run <https://github.com/milkdudpoe/refund-reconciler/actions/runs/38037209436>.
  The owner's reply did not separately reconfirm the installed ZIP's checksum
  or source commit.

What this result supports: in that desktop Chrome, a toolbar click gave the
extension access to the active amazon.com tab, the selection was read and
refused as a refund report ("Cannot propose a report from this selection"),
and the dashboard was empty afterwards (nothing was saved).

What it does not show: that real Amazon refund wording is recognised, that
updating through Chrome's extensions UI keeps data, anything about other
Chrome versions or operating systems, store approval, or customer demand.

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
[beta.md](beta.md#update-checks-050-and-060-to-this-beta-in-the-same-installation).
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
| Toolbar grant on public amazon.com (desktop Chrome) | **not run** (at Task 07) | No real desktop Chrome toolbar was available in the environment used. Later owner-reported as a pass; see [Task 08](#task-08-owner-reported-toolbar-check-reported-2026-10-10). |
| Real Amazon refund line (optional) | **not run** | Needs the owner's own suitable order; no access was available or requested. |
| Update in place through the `chrome://extensions` UI (optional) | **not run** | Automated check covers reload and restart in bundled Chromium only. |

## Reusable manual toolbar checklist

The owner-reported result above covers this check for the 0.6.0 beta only.
**0.7.0 changed the popup, so this check must be run again for 0.7.0.**
Keep the checklist for future builds (for example after a permission,
manifest or popup change) or for another Chrome version. It needs desktop Chrome and no
account (details in
[beta.md, Check 1](beta.md#check-1-the-actual-toolbar-grant-no-account-or-private-data-needed)):

1. New, temporary Chrome profile. `chrome://extensions` → Developer mode →
   **Load unpacked** the extracted CI beta ZIP (check it against the
   `.sha256` that came with it). Pin the icon. From 0.7.0: open the
   dashboard and complete **Protect your records** with a throwaway
   passphrase; optionally first confirm that, before setup, the toolbar
   panel only offers to open the dashboard.
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
