# Case summaries and local data export (Task 03)

Restoring a JSON backup (Task 04) is described in [restore.md](restore.md).

Two read-only exports built from evidence already saved in this browser
profile. Neither one contacts Amazon, sends a message, uploads anything, adds a
permission or changes saved data. They use the same validated data and pure
derivations (`summarizeCase`, `summarizeItem`, `buildTimeline`) as the
dashboard.

Code: `src/export/summary.ts` and `src/export/backup.ts` are pure (no storage,
DOM, clipboard or download access). The dashboard (`src/ui/app.ts`) reads the
snapshot and shows the preview; `src/ui/deps.ts` does the clipboard write and
the Blob/object-URL download.

## Case summary (plain text)

**Where:** open a case, then **Prepare case summary…**. The preview explains
what is included and shows the exact text that **Copy text** and **Download
text** use. You send or share it yourself.

**Contents:**

- retailer, order reference (or "Not recorded"), currency, generation time
  (UTC) and saved-data revision; a prominent banner for synthetic demo cases;
- a short "About this summary" section: the records are the account holder's
  own, are not verified by Amazon or any bank, "confirmed received" means the
  user recorded the money arriving, merchant reports are merchant statements
  rather than receipt confirmations, and an unresolved expected amount is a
  difference in the records, not a proven amount owed;
- case overview: status, unresolved total (sum of per-item shortfalls only),
  excess total (never offset against other items), count of unknown
  expectations;
- for each item: label, current expected refund or Unknown, latest active
  merchant-issued snapshot or "None recorded", user-confirmed receipts,
  recharges, confirmed net received, unresolved amount / excess / "Unknown —
  cannot be calculated", review conditions, and a brief factual explanation
  (partial confirmation, later recharge, conflicting merchant report, issued
  but unconfirmed, unknown expectation). Several merchant snapshots are noted
  as snapshots that are not added together. A review condition is still shown
  when the difference is zero;
- a chronology in **recording order** (never re-sorted by event date). Each
  entry shows its number, kind, item, recorded time, optional occurrence date
  ("not given" when unknown) and source. Voided entries are kept and marked
  `[VOIDED by entry N — kept as history, excluded from current totals]`, and
  each void names the entry it voids. Expected-amount changes read "changed
  from X to Y". Captured merchant reports are described as merchant statements
  recorded from selected page text, with capture time, page origin and
  sanitised path, parser version (including historical versions, shown as
  stored and never re-parsed), approved amount text and any order number found
  in the selection.

**Omitted by default:** free-text notes (including void reasons), transaction
or observation references, and captured excerpts. Entries that have them are
marked `[omitted]`. Ticking **Include evidence details** regenerates the
visible preview from the same snapshot before anything is copied or
downloaded. Amounts, discrepancies and review conditions are never omitted.

**Literal text:** the preview is a read-only `<textarea>`; nothing is rendered
as HTML or Markdown. In the generated text, line breaks, other control
characters and bidirectional-override characters inside stored text are
replaced with spaces, so a label or note cannot forge extra lines. Captured
excerpts (when included) keep their lines, each prefixed with `| `.

## Portable JSON data export

**Where:** dashboard list → **Your data** → **Download all data (JSON)…**. One
confirmation panel shows the snapshot time and revision and counts (your
cases, synthetic demo cases, items, entries including voids, captured
reports), and states that the file contains all cases, notes, references and
captured excerpts and is an ordinary unencrypted file.

The dashboard's search and status filter (Task 05) never narrow this file:
it always contains every stored case, including synthetic demo cases and all
history, whatever the case list currently shows. Filtering does not change
the snapshot's freshness checks.

**Format:**

```json
{
  "format": "refund-reconciler-backup",
  "formatVersion": 1,
  "exportedAt": "2026-10-10T12:05:01.123Z",
  "store": { "schemaVersion": 1, "revision": 12, "cases": [] }
}
```

- `format` / `formatVersion` describe this envelope. `formatVersion` is
  independent of the ledger's `store.schemaVersion`.
- `exportedAt` is when the snapshot was read.
- `store` is the validated stored ledger exactly as read: every real and
  synthetic case, all items, every original entry (including voided entries,
  voids and expected-amount history), IDs, timestamps, sources, notes,
  references and capture provenance (including historical parser versions).
  Money stays integer cents; unknown amounts stay `null`. No formatted strings
  or recomputed summaries are added. `store` validates unchanged with the
  existing `parseStore` validator (tested).

- `store.lastRestore` is present only if the exported ledger was itself
  created by a restore (Task 04). It is the destination's own bookkeeping,
  exported so later exports keep the complete ledger; when such a file is
  restored elsewhere it is treated as source metadata and is not carried over.
- `store.ledgerEpoch` is present only if the exported ledger was explicitly
  erased at some point (an opaque random marker, no user data). It is exported
  as part of the ledger and ignored when the file is restored elsewhere.

**Restore:** a file in this format can be restored into a browser profile
whose ledger has no cases; see [restore.md](restore.md). Files exported by
Task 03 builds (without `lastRestore`) are accepted unchanged.

## Snapshots

Opening either export performs a fresh, validated read of saved data through
the service worker (which decrypts it; from 0.7.0 pages never read storage
themselves), and the page validates the reply again; the page's
already-loaded copy is never used. Exports are available only while the
records are unlocked, and **Copy text** and **Download** re-check with the
worker **when pressed** that the records are still unlocked and the snapshot
still current (within the click's user activation). The preview and every copy/download use
that one immutable snapshot, so what you see is what is exported.

- **Changes during a read.** The dashboard counts storage change events. If a
  change arrives while a snapshot read (initial or Refresh) is in flight, that
  result may predate the change, so it is discarded and storage is read again
  before anything is shown as ready. If storage keeps changing for three
  consecutive reads, the last result is shown only as an earlier snapshot with
  copy/download disabled until you refresh. A failed read stays blocked; an
  older result is never turned into a current one.
- **Changes after a read.** The moment a storage change event reaches the
  dashboard, before its revalidation read starts, a ready panel is marked as
  an earlier, unverified snapshot ("Checking whether it is still current…")
  and new Copy/Download are refused. The event does not say what changed, only
  that the snapshot needs checking. The visible text is not replaced, and a
  copy already in progress keeps its exact text, detail choice and locked
  controls. When the revalidation read for the **latest** observed change
  returns:
  - if the data behind the export is unchanged (for a summary: that case; for
    the JSON export: the whole store), the snapshot is current again and
    export is re-enabled;
  - if it changed, the case was deleted, or the read failed, the panel says so
    and stays locked until you choose **Refresh** (a refresh of a deleted case
    reports that it no longer exists).

  Reads that started before the snapshot's own read, or before a later change
  event, never decide; once marked changed, deleted or unverified, a snapshot
  stays so until an explicit refresh. Late, failed or out-of-order reads
  therefore cannot roll it back to current.

## Errors

- **Locked (0.7.0):** Lock now or an erase in any view closes the export
  panel in every view at once and drops its prepared text. A copy or
  download whose action-time check is still running is not started. A
  download already requested and text already on the clipboard cannot be
  recalled.
- **Storage read failure, corrupt or unsupported data:** the export is
  blocked with an explanation that a valid snapshot cannot be read. No empty
  ledger is substituted, no file is produced and nothing is reset or
  overwritten. **Try again** re-reads storage. On the corrupt/unsupported
  screen the export actions are not offered at all; the raw-data view there is
  unchanged. A raw recovery export may come later.
- **Copying:** pressing **Copy text** freezes that preview text and its
  evidence-details choice. Until the clipboard write settles the panel shows
  "Copying…", the details checkbox and Refresh are disabled, and further Copy
  presses are refused, so the preview cannot change under a pending copy.
  "Copied" is shown only after the write resolves and names whether evidence
  details were included. If saved data changed meanwhile, the message says the
  earlier snapshot was copied (or, while the change is still being checked,
  the earlier, unverified snapshot) and the warning and export lock stay. If
  the panel was closed or reopened, a late completion is ignored and the new
  panel is unaffected. Nothing is written to the clipboard without a new click.
- **Clipboard refused:** the panel says the text was not copied, re-enables
  the controls and selects the full preview for manual copying; a later Copy
  can succeed. No permission is added.
- **Download:** a Blob/object-URL download link is clicked; the panel says
  "Download requested", not that the file was saved, because the browser
  decides that. Errors while creating the file or starting the download are
  reported and change nothing. Object URLs are revoked 60 seconds later.
- **Filenames** are constant: `refund-reconciler-case-summary-<UTC
  timestamp>.txt` and `refund-reconciler-backup-<UTC timestamp>.json`. They
  never include labels, order references or other stored text.

Exports never create entries, change the revision, migrate data, re-run a
capture parser or update financial state. Unsaved forms and pending/uncertain
save state on the dashboard are kept while the export panel is open or closed.
Escape or **Close** closes the panel and returns focus to the button that
opened it.

## Privacy

Both exports are produced only after an explicit click; nothing is copied or
downloaded when a panel opens. Downloaded files and copied text are ordinary,
**unencrypted** plaintext in your downloads folder or clipboard, outside the
extension's control, even though the saved ledger is encrypted (0.7.0). A
JSON backup never contains the passphrase, a key or vault metadata. The one
export available before unlocking is the explicit **Download plaintext backup
(JSON)** of an earlier version's records before migration ([vault.md](vault.md)). The JSON file always
includes notes, references and captured excerpts; the summary includes them
only if you opt in.

## Verification

Unit tests (`tests/unit/export.test.ts`) check the generated text and envelope
for the acceptance cases. Browser tests (`tests/e2e/export.spec.ts`) use the
built extension in Playwright's Chromium: they capture real download events and
read the downloaded files, read the real clipboard back by pasting, inject a
clipboard rejection and storage read failures from test code only, and check
that stored data and revision are unchanged. `tests/e2e/export-races.spec.ts`
covers interleavings with deterministic gates: a page's next read reply (its
`read` request to the service worker) is held only after the worker has
answered it,
while a second dashboard changes or deletes data through the real service
worker; clipboard writes really happen and only their completion is held.
Observing a held change-triggered read proves the page has already processed
the storage-change event, so the event-time lock is asserted before any
revalidation result is delivered.

## Limitations

- Exports describe what the user recorded. They are not bank-verified, are not
  endorsed by Amazon and do not establish legal entitlement.
- The capture parser is still validated only against synthetic fixtures;
  real Amazon refund wording is untested. The toolbar grant was
  owner-reported as passing on 2026-10-10 (see
  [validation.md](validation.md)).
- Restore only into an empty ledger (no merge or partial import); no
  reminders, automatic support messages or whole-page capture.
- These exports do not establish willingness to pay or readiness for paid
  positioning.
