# Beta validation record

What has and has not been checked for the beta. Synthetic data only; no
private data, browser profiles, passphrases or backups are kept in this
repository. This is not commercial validation, evidence of customer demand
or Chrome Web Store approval.

## Current status (as of 2026-10-10, version 0.8.0)

| Check | Status | Source |
| --- | --- | --- |
| Automated suites, extracted-ZIP smoke test, same-installation updates 0.5.0, 0.6.0 and 0.7.0 → 0.8.0 (bundled Chromium) | pass locally on the Task 10 branch; CI is recorded in the Task 10 pull request | [Task 10](#task-10-080-data-practices-disclosure-and-agreement-2026-10-10) |
| Toolbar access on the public amazon.com home page (desktop Chrome), **0.8.0** | **not run**: the popup changed (nothing before agreement, nothing while locked), so a new owner-operated check is needed | — |
| Toolbar access, **0.7.0** | **not run** | — |
| Toolbar access, **0.6.0** (context only) | pass, owner-reported (not independently reproduced) | [Task 08](#task-08-owner-reported-toolbar-check-reported-2026-10-10) |
| Real Amazon refund wording (optional) | **untested** | — |
| Update in place through the `chrome://extensions` UI (optional) | **untested** | — |

## Task 10: 0.8.0 data-practices disclosure and agreement (2026-10-10)

What changed ([consent.md](consent.md)): an in-product disclosure with
**Agree and continue** / **Not now** before any data feature; a versioned,
nonprivate consent receipt (`DATA_PRACTICES_VERSION = 1`); enforcement in the
service worker before any key derivation, decryption or write; **Data and
privacy** to reread the text; the typed erase also removes the receipt.
Permissions, ledger schema 1, backup format 1, vault format 1, encryption
parameters and the session lifecycle are unchanged. Started from the reviewed
Task 09.1 head `da47584` (merged in PR #9).

Automated evidence (synthetic data only; bundled Chromium 141.0.7390.37 in a
Linux container):

- `tests/unit/consent.test.ts` (16 tests): receipt and message validation,
  current/obsolete/invalid receipts, storage errors fail closed, idempotent
  acceptance, rejected writes, lost replies resolved by a fresh read after a
  worker restart, refusal of every direct data request with records
  unchanged and no WebCrypto call (spied), Lock and erase without agreement,
  erase removing the receipt in the same removal, no revival of earlier
  restore approvals, and the receipt kept out of the ledger.
- `tests/e2e/consent.spec.ts` (13 tests, production worker and UI): see
  [consent.md](consent.md#tests). Shared fixtures agree through the real UI
  before setup or unlock; dedicated gate tests stay unaccepted; earlier
  baselines are driven without the gate because they have none.
- A deliberately weakened worker gate (refusing only `read`) made 4 of the
  unit tests fail; the code was then restored.
- Update checks from 0.5.0, 0.6.0 and **0.7.0** (new baseline,
  `da475840933b21eab85553e8b2ad54c3e049bf90`), each built from its own
  source and lockfile and updated in place to the unchanged extracted 0.8.0
  ZIP: agreement required first with storage byte-for-byte unchanged and the
  popup gated; then migration (0.5.0/0.6.0) or the same encrypted 0.7.0 vault
  unlocked with its existing passphrase (no reset, no plaintext); restart,
  export, refused restore into a populated ledger, a new encrypted write, and
  recovery into a separate profile.

Local run on the Task 10 working tree before commit (Linux container): one
complete `npm run check`: typecheck, lint, **385** unit tests (369 + 16),
**115** browser tests (102 + 13), the extracted-ZIP smoke test (1) and the
three update checks (3), all passed on that run; `git diff --check` clean.
These are local results, not CI; CI for the final head is recorded in the
Task 10 pull request.

Not covered: a real toolbar click on 0.8.0 (Check 1 must be run again; the
0.6.0 owner result does not cover 0.7.0 or 0.8.0), real Amazon refund
wording, updating through the `chrome://extensions` UI, publisher inputs, a
hosted policy, store images and any store review.

## Task 09.1: stale replies after Lock or erase (2026-10-10)

Independent review of the Task 09 head `3c9513b` reproduced two defects,
against both the production build and the Ubuntu CI ZIP:

1. **Popup:** an unlocked `read` reply delivered after a newer Lock (or erase)
   replaced the locked state, so **Capture selected refund text** came back
   while the worker reported `locked`. Fixed in `src/popup/popup.ts`: reads
   are numbered when sent; a reply is applied only if it is newer than the
   last applied one and was sent after the last change signal; every
   locked-out state advances the privacy epoch even while idle; capture and
   save-outcome recovery use the same guarded read, and a capture attempt only
   changes the popup while it still owns the phase.
2. **Dashboard:** a held `readLegacy` reply released after an external erase
   started a plaintext download of the erased records. Fixed in
   `src/ui/vault.ts` and `src/ui/app.ts`: the pre-migration backup is an
   operation that the dashboard abandons on every state-change signal and
   whenever a read shows a different state; after each asynchronous step it
   must still be current, and a fresh guarded state check must still allow a
   legacy backup immediately before the download starts. A message about a
   backup is cleared with the state it describes. A download already started
   cannot be recalled.

The same review reported a full local browser run of **95 of 96** for the
Task 09 head: `tests/e2e/help.spec.ts` ("using the guide keeps …") failed
once because it snapshotted the restore panel before file validation had
settled. That run was not a pass. The test now waits for the settled
`preview` phase and `not_empty` destination before the snapshot; production
restore behaviour is unchanged.

Regressions added (`tests/e2e/vault-races.spec.ts`, 6 tests; real worker,
replies held only after the worker answered): an idle popup's unlocked
refresh released after Lock; the same ordering across erase; an older locked
reply overtaken by a genuine unlock; a held capture check released after
Lock (instrumented: no tab look-up, selection read or injection); a held
legacy backup released after an external erase (no download start, no stale
message, while a backup in the unchanged state exports the complete ledger);
a held legacy backup released after migration finished elsewhere and the
records locked. All six **failed on the unfixed `3c9513b` code** at the
assertion right after the held reply was released, and pass with the fix.

Local runs (same Linux container and bundled Chromium 141.0.7390.37 as
below): the 6 new tests repeated 10 times (60 passed); the corrected help
test repeated 20 times (20 passed); then one complete `npm run check`:
typecheck, lint, **369** unit tests, **102** browser tests (96 + 6), the
extracted-ZIP smoke test (1) and both update checks (2), all passed on the
first run. CI for the corrected head is recorded in PR #9.

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
| Browser suite (`npm run test:e2e`) | **96 passed** in this author's run (was 87); an independent full run had 95/96 (see Task 09.1) | the 87 earlier tests adapted to set up/unlock through the real UI, plus 9 in `tests/e2e/vault.spec.ts` |
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
**0.7.0 and 0.8.0 changed the popup, so this check must be run again for
0.8.0.** It has not been run for either version.
Keep the checklist for future builds (for example after a permission,
manifest or popup change) or for another Chrome version. It needs desktop Chrome and no
account (details in
[beta.md, Check 1](beta.md#check-1-the-actual-toolbar-grant-no-account-or-private-data-needed)):

1. New, temporary Chrome profile. `chrome://extensions` → Developer mode →
   **Load unpacked** the extracted CI beta ZIP (check it against the
   `.sha256` that came with it). Pin the icon. 0.8.0: optionally first click
   the toolbar icon on any page and confirm the panel only offers **Open
   dashboard to review** and says nothing on the page was read. Then open
   the dashboard, read the data practices, choose **Agree and continue**,
   and complete **Protect your records** with a throwaway passphrase
   (optionally confirm first that, before setup, the panel only offers to
   open the dashboard).
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
