# Case summaries and local data export (Task 03)

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

**Restore is not implemented.** This milestone creates a portable copy only;
the extension cannot import it yet.

## Snapshots

Opening either export performs a fresh, validated read of storage; the page's
already-loaded copy is never used. The preview and every copy/download use
that one immutable snapshot, so what you see is what is exported. If saved
data changes while the panel is open (in this or another dashboard), the panel
is marked as an earlier snapshot and copy/download are disabled until you
choose **Refresh**. If the case was deleted, the panel says so, and a refresh
reports that the case no longer exists.

## Errors

- **Storage read failure, corrupt or unsupported data:** the export is
  blocked with an explanation that a valid snapshot cannot be read. No empty
  ledger is substituted, no file is produced and nothing is reset or
  overwritten. **Try again** re-reads storage. On the corrupt/unsupported
  screen the export actions are not offered at all; the raw-data view there is
  unchanged. A raw recovery export may come later.
- **Clipboard refused:** "Copied" is shown only after the clipboard write
  resolves. If it is refused, the panel says the text was not copied and
  selects the full preview for manual copying. No permission is added.
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
downloaded when a panel opens. Downloaded files are ordinary, unencrypted files
in your downloads folder, outside the extension's control. The JSON file always
includes notes, references and captured excerpts; the summary includes them
only if you opt in.

## Verification

Unit tests (`tests/unit/export.test.ts`) check the generated text and envelope
for the acceptance cases. Browser tests (`tests/e2e/export.spec.ts`) use the
built extension in Playwright's Chromium: they capture real download events and
read the downloaded files, read the real clipboard back by pasting, inject a
clipboard rejection and storage read failures from test code only, and check
that stored data and revision are unchanged.

## Limitations

- Exports describe what the user recorded. They are not bank-verified, are not
  endorsed by Amazon and do not establish legal entitlement.
- Capture is still validated only against synthetic fixtures; live Amazon
  compatibility and the real toolbar-grant flow remain outstanding.
- No import or restore, reminders, automatic support messages or whole-page
  capture.
- These exports do not establish willingness to pay or readiness for paid
  positioning.
