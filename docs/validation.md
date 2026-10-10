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
- **Environment:** Linux cloud container, Node 22.22.0, Playwright 1.56.1
  with **bundled Chromium 141.0.7390.37** (not installed desktop Chrome);
  CI on `ubuntu-latest`.

### Automated (pass)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck, lint | `npm run typecheck`, `npm run lint` | pass |
| Unit tests | `npm test` | 319 passed (13 files) |
| Browser suite (dist/) | `npm run test:e2e` | 87 passed |
| Extracted-ZIP smoke test | `npm run test:package` | 1 passed |
| Same-installation update 0.5.0 → 0.6.0 | `npm run test:update` | 1 passed |

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

Packaging was repeated several times in this environment and gave the same
ZIP SHA-256 each time. Checksums from a different environment (for example a
Windows CRLF checkout) can differ; see beta.md.

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
