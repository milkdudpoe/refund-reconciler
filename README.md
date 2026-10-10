# Refund Reconciler

A local Chrome extension (Manifest V3) that helps you see which return/refund
records are unresolved or contradictory, item by item.

> **Status: Task 04 — manual entry, explicitly approved selected-text
> capture, local exports and restore into an empty ledger. Not a validated
> product.** You can enter
> evidence manually, or highlight a refund line on an Amazon US page and
> approve a previewed merchant-report snapshot (see
> [docs/capture.md](docs/capture.md)). You can copy or download a plain-text
> case summary to use when contacting support yourself, and download a JSON
> copy of all saved data (see [docs/export.md](docs/export.md)), and restore
> that JSON copy into a browser profile with no saved cases (see
> [docs/restore.md](docs/restore.md)). Capture
> has been tested only against synthetic fixtures, not live Amazon pages, and
> the real toolbar-grant flow has not been validated manually.
> There is no automatic reconciliation, whole-page extraction or history
> crawling, and no payment/commercial validation. The tool tracks evidence; it
> does not move money, file disputes, or establish legal entitlement to a
> refund.

Scope: Amazon US orders, USD only.

## Requirements

- Node.js **22.12 or newer** (developed with 22.22.0, see `.nvmrc`) and npm 10.
- Chrome/Chromium 120+ to load the extension.
- Browser tests use Playwright **1.56.1**'s bundled Chromium. If it is not
  already present, run `npx playwright install chromium` once.

## Commands

```sh
npm ci              # install exact versions from package-lock.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # Vitest unit tests (domain, validation, persistence, handler)
npm run build       # Vite build of the extension into dist/
npm run test:e2e    # build, then Playwright tests against the real unpacked extension
npm run check       # all of the above
```

## Install the unpacked extension

1. `npm ci && npm run build`
2. Open `chrome://extensions`, switch on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/` folder.
4. Click the Refund Reconciler toolbar button (pin it from the puzzle-piece
   menu if needed). A small panel offers **Open dashboard** and **Capture
   selected refund text**.

## Capture a refund line from Amazon US

Highlight the refund line for one item on an `https://www.amazon.com` page
(for example `Refund issued: $35.00`), click the toolbar button, and choose
**Capture selected refund text**. Check the preview, choose the case and item
yourself, confirm the amount applies to that item, and choose **Save merchant
report**. Nothing is stored before you save. The supported wording, the
safeguards and the limitations are in [docs/capture.md](docs/capture.md).

After rebuilding, press the reload icon on the extension's card.

## Export a case summary or your data

- **Case summary:** open a case and choose **Prepare case summary…**. The
  preview shows the exact plain text (items, amounts, review conditions,
  explanations and the evidence chronology). Notes, transaction references and
  captured excerpts are left out unless you tick **Include evidence details**.
  Choose **Copy text** or **Download text** and share it yourself; nothing is
  sent to Amazon.
- **All data:** on the case list, **Your data → Download all data (JSON)…**
  downloads every case (including demo cases), note and excerpt as an
  unencrypted JSON file.

Exports never change saved data. Format, snapshot behaviour and error handling
are in [docs/export.md](docs/export.md).

## Restore a JSON backup

On the case list, **Your data → Restore from JSON…** (or **Restore from a JSON
backup…** on a completely empty dashboard) restores a file made with Download
all data (JSON):

- Only that backup format (format version 1, ledger schema 1), at most
  **25 MiB**. The file is validated in the dashboard and again in the service
  worker; invalid files are refused with a specific reason and nothing is
  written.
- You see a preview (export time, versions, counts, the case list, demo
  labels; notes, references and excerpts collapsed) before anything is saved.
  Choosing or previewing a file writes nothing.
- **Only into an empty ledger.** Any existing case, including synthetic demo
  cases, blocks restore; corrupt or unreadable saved data blocks it too.
  Restore never merges, replaces, deletes or clears existing cases. Delete
  cases yourself first if you really want to replace them.
- Restore writes every original case, item and entry unchanged (ids, times,
  voids, history, provenance) and adds a small `lastRestore` receipt in the
  same write, used to recognise the operation after a lost reply. The
  destination revision continues from its own counter. A restore is approved
  against the destination's revision, existence and erase marker, so a request
  approved before an erase is refused after it.
- After completion the panel re-reads saved data and says whether it still
  matches the restore, has changed since, or could not be verified.
- Restored records are not verification of money received, and the file is
  not encrypted or authenticated.

Retry, erase and compatibility details, and exactly what was tested, are in
[docs/restore.md](docs/restore.md).

## Permissions and data

| Permission | Why |
| --- | --- |
| `storage` | Saves your cases in `chrome.storage.local` in this browser profile. |
| `activeTab` | Clicking the toolbar button grants temporary access to the current tab only; it ends when you leave the page. |
| `scripting` | After you choose Capture, runs one bundled function in that tab to read the selected text and page URL. |

No host permissions, no `tabs` permission, no declared content scripts, no
background scanning, network requests, analytics, remote code or model calls.
All JavaScript is bundled into `dist/`. Only `https://amazon.com` and
`https://www.amazon.com` pages can be captured. Page code cannot access the
ledger, because the service worker restricts `chrome.storage.local` to trusted
extension contexts.

**What is stored:** one key, `refundReconciler.store`, containing your cases:
optional order reference, item descriptions, expected amounts, and every
merchant report, receipt confirmation, recharge, void and expected-amount edit
you enter (amounts, optional dates, references, sources, notes and the time
each was recorded). For a captured merchant report it also stores the excerpt
you approved (at most 4,000 characters), the page origin and a sanitised path
(tracking segments, fragments and all query parameters except a valid order
ID are dropped), the capture time, the parser version and the approved amount
text. The page's HTML, cookies, screenshots and anything you did not select
are never collected. Nothing from a capture is stored until you approve it. Data stays in this browser profile and is **not
encrypted** by the extension; anyone with access to the profile can read it.
It is not synced (`chrome.storage.sync` is not used).

**Restore:** a backup file is read only after you choose it in the file
input, kept in the open panel's memory, and written only when you choose
Restore (into an empty ledger). Its text is shown as text only and is never
executed or logged.

**Exports:** case summaries and JSON data copies are created only when you
click Copy or Download. Downloaded files are ordinary unencrypted files that
the extension cannot track or delete. No `downloads` or clipboard permission
is used.

**What is deleted:**
- *Delete case…* → *Permanently delete* removes that case, its items and all
  its evidence from storage.
- *Remove synthetic demo* removes only the demo cases.
- If stored data is unreadable or from an unsupported version, the dashboard
  shows it read-only and blocks changes. *Erase stored data…* → *Permanently
  erase* replaces everything with an empty ledger that keeps only a random
  erase marker (`ledgerEpoch`, no user data), so restore approvals made before
  the erase can never apply afterwards; nothing is erased automatically.
- Removing the extension from Chrome deletes all of its stored data.

## Project layout

```
src/domain/       pure model, money parsing, derivations, ledger, restore decision, runtime validation
src/capture/      source checks, page collector, acquisition, deterministic excerpt parser
src/export/       pure case-summary text, JSON backup envelope, size bound and payload digest
src/persistence/  chrome.storage.local read/write (validated, never auto-reset)
src/background/   service worker: message validation + serialised writes
src/ui/           dashboard (plain TS + CSS, text-only rendering)
src/popup/        toolbar popup: Open dashboard, capture preview and approval
public/manifest.json
tests/unit/       Vitest
tests/e2e/        Playwright MV3 extension harness (persistent Chromium profile,
                  synthetic Amazon-like fixtures served in-browser, no network)
docs/             product scope, data model, capture, export, restore
```

See [docs/product-scope-and-data-model.md](docs/product-scope-and-data-model.md)
for the derivation rules, limitations and next milestone, and
[docs/capture.md](docs/capture.md) for the capture flow, parser patterns and
what was or was not verified, [docs/export.md](docs/export.md) for the
summary and backup formats, and [docs/restore.md](docs/restore.md) for
restoring a backup.

Capture browser tests cannot click the real toolbar button, so they load a
temporary copy of `dist/` with host access to the synthetic fixture hosts
only. The shipped `dist/` is checked separately and never gets those
permissions (details in docs/capture.md).

## Known dev-tooling advisories

`npm audit` reports advisories in Vitest 3.2's dev-only dependencies
(`tinypool`, `@vitest/mocker`). The fix requires a Vitest major upgrade that
npm 10.9 currently fails to resolve; nothing from these packages ships in
`dist/` (`npm audit --omit=dev` is clean). Revisit when upgrading Vitest.
