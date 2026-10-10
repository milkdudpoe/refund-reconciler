# Product scope and data model (Tasks 01–05)

## Scope

- **Retailer / currency:** Amazon US, USD only.
- **What it does:** keeps a per-item evidence log for returns and derives which
  expected refunds are confirmed, partially confirmed, unconfirmed, reopened by a
  recharge, or exceeded — so the user knows what needs review.
- **What it does not do:** move money, contact merchants, file disputes, read
  email or bank data, scrape or crawl pages, or decide legal entitlement. Differences are
  shown as *unresolved expected amounts* or *records needing review*, never as
  money guaranteed to be owed.
- **Evidence** is entered manually, captured from text the user selects on an
  Amazon US page and explicitly approves (Task 02, merchant reports only; see
  [capture.md](capture.md)), or comes from a synthetic demo the user must opt
  into. The demo is stored with `isDemo: true`, labelled "Synthetic", listed
  separately, and never receives captured evidence.

## Data model

All amounts are **non-negative safe integer cents**. User input is parsed from
the digit string (with BigInt) and rejected if malformed, negative, more precise
than cents, or above $1,000,000,000.00. Sums use checked integer addition.

```
StoreData { schemaVersion: 1, revision, cases[], lastRestore?, ledgerEpoch? }
RestoreReceipt (lastRestore) { operationId, payloadSha256, restoredAt, restoredRevision,
             sourceExportedAt, sourceRevision, caseCount }
CaseRecord { id, retailer: 'amazon_us', orderRef | null, currency: 'USD',
             isDemo, createdAt, updatedAt, items[], entries[] }
ItemRecord { id, label, createdAt }
Entry (append-only; common fields: id, itemId, recordedAt, occurredOn | null, source, note)
  expectation      amountCents | null   user-approved expected refund; null = unknown
  merchant_report  amountCents, reference | null, capture?   merchant's reported issued total (snapshot);
                   optional `capture` provenance when approved from selected page text
  receipt          amountCents > 0, reference | null   user confirms money received
  recharge         amountCents > 0, reference | null   user records money taken back
  void             targetEntryId, note = reason   marks an earlier report/receipt/recharge mistaken
```

Entries are never edited or removed (except by deleting the whole case).
The optional `capture` field (see [capture.md](capture.md#stored-provenance))
was added without changing `schemaVersion`; Task 01 data reads unchanged.
The optional `lastRestore` receipt (Task 04, see [restore.md](restore.md))
was added the same way: it is written only by a restore from a backup file, in
the same record as the restored cases, and is validated on every read. Ledgers
and backup files without it stay valid. The optional `ledgerEpoch` (Task 04.1)
is an opaque random marker written only by an explicit erase, which now stores
`{ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch }` instead of removing
the key; every other write keeps it, and an imported one is ignored.
Item/case status is never stored; it is recomputed from entries every time.

## Derivation rules

Per item, using only non-voided entries:

- `expected` = the latest expectation entry (may be `null` = unknown).
- `confirmedReceived` = Σ receipts; `recharged` = Σ recharges;
  `net = confirmedReceived − recharged` (may be negative).
- `merchantReported` = the **latest** merchant report. Reports are dated
  snapshots of the merchant's total; they are never added together and never
  count as money received.
- `difference = expected − net` only when `expected` is known; otherwise unknown.
  Positive → unresolved expected amount. Negative → excess, kept as its own
  review condition.

Item status:

| Condition | Status |
| --- | --- |
| expected unknown | `expectation_unknown` (difference unknown, never zero) |
| difference = 0 | `settled` |
| difference < 0 | `excess` (needs review) |
| difference > 0 and any recharge | `reopened` (needs review) |
| difference > 0 and some receipt | `partial` |
| difference > 0, no receipt, merchant reports > $0 | `issued_unconfirmed` |
| otherwise | `unconfirmed` (no confirmation ≠ nothing received) |

Flags: merchant reports more / less than confirmed net; receipts recorded while
the expectation is unknown.

Review reasons (per item, kept separate from the financial status):

- `excess` — confirmed net exceeds the known expectation;
- `reopened` — a recharge brought confirmed net below the expectation;
- `merchant_reports_less_than_confirmed` — the latest active merchant snapshot
  is lower than confirmed net. The item can still be financially `settled`
  (difference $0, nothing implied owed); the evidence contradicts itself and
  needs a human check. Voiding the mistaken entry, or a newer matching
  snapshot, clears it.

A merchant reporting *more* than confirmed is **not** a review reason: an
issued refund awaiting confirmation is an ordinary state (`issued_unconfirmed`
or `partial`).

Case status, in precedence order:

1. `needs_review` if any item has a review reason — this always prevents an
   all-clear, even when every item is balanced;
2. `settled` if **every** item is settled on its own;
3. otherwise `open`.

The case list and case detail both show the review reasons.

Case totals: `unresolved` = Σ positive item differences (known expectations
only); `excess` = Σ item excesses, reported separately. One item's excess never
offsets another item's shortfall. A recharge after settlement recomputes the
item as `reopened`, so the case leaves `settled`.

## Dashboard overview and case finder (Task 05)

Read-only views over the same derivations (`src/domain/overview.ts`). Nothing
is stored: no new fields, no writes, no reordering of stored cases or evidence.

**Overview** — shown above the case list, always for **all real cases**
(`isDemo: false`), never for the filtered view and never including synthetic
demo cases (even when demo cases are the only stored data):

| Figure | Definition |
| --- | --- |
| Unresolved expected amounts | Σ over real cases of `summarizeCase(c).unresolvedCents`, using checked integer-cent addition. If the sum is not a safe integer it shows *Total unavailable* with an explanation; no inexact number is shown, and every case row keeps its own figures. |
| Items with unknown amounts | Σ `unknownExpectationCount`. Shown separately; unknown amounts are never treated as zero or estimated. |
| Cases needing attention | Cases whose status is not `settled` (open, unknown expectations, and every review condition). |
| Cases needing review | Cases whose status is `needs_review`, including a balanced contradiction (difference $0.00 but the latest merchant report is below confirmed receipts). |

Merchant reports stay status snapshots: they never enter the overview as
receipts, and repeated snapshots do not add up. Excess on one item never
offsets another item's unresolved amount, because only the per-case
`unresolvedCents` (Σ positive item differences) is added. The overview says
the totals come from the user's own saved evidence and are not confirmation
that money is owed or that a refund was made. With no real cases it says so
and makes no claim that the user's refunds are settled.

**Finder** — a search field and one status selector, applied together:

- *Search* is a literal, case-insensitive substring match (JavaScript
  `toLowerCase` on both sides; no regular expressions, no markup) on the case's
  order reference and its item descriptions only. Notes, transaction
  references, sources and captured excerpts are not searched. The query is
  trimmed; blank means no restriction; it is limited to 200 characters
  (`maxlength` plus a cut in the helper). Stored text is never changed.
- *Status*: All cases (initial), Needs attention (`status !== 'settled'`),
  Needs review (`status === 'needs_review'`), Settled (`status === 'settled'`).
- *Display order* of matching real cases: `updatedAt` descending, then case
  id ascending as a deterministic tie-break. Storage order and evidence
  chronology are unchanged. The synthetic demo section keeps its own list,
  in stored order, and is never searched or counted.
- The result count is shown (and announced to screen readers once typing
  pauses, or at once for a status change). *Clear filters* resets both.
  *No cases match* is distinct from *No cases yet*: it shows how many cases
  are saved and does not offer restore.
- The query and status live only in the open dashboard's memory. They survive
  opening a case and returning, and storage changes from other views; a newly
  opened dashboard starts at All with an empty query. Each storage change
  re-reads and re-validates saved data, so totals and membership follow new
  captures, receipts, voids, expectation edits, deletions, demo changes and
  restores. If saved data cannot be read or is invalid, the existing
  error/read-only screen replaces the list and overview; nothing is shown as
  current or as an empty ledger until a valid read succeeds.
- The search field, status selector and their containers stay attached to
  the page across re-renders, so focus, caret, selection and characters typed
  during a storage change are kept, including when the dashboard is a
  background window.
- Exports are unaffected: the JSON copy always contains all stored data, and
  a case summary contains that case, whatever the finder shows.

## Idempotency and conflicts

- Every entry carries a caller-generated ID (the dashboard creates one when a
  form opens, so a double submit is harmless). Same ID + same contents → no-op
  (`duplicate`). Same ID + different contents → `conflict`; nothing is
  overwritten.
- An optional transaction/observation **reference** is checked the same way
  among active entries of the same kind across all cases. A voided entry's
  reference can be reused so a typo can be corrected.
- Different IDs are always different evidence, even with equal amounts.
  Nothing is ever matched by amount alone.
- A captured report's ID is its capture operation ID. Its provenance (excerpt,
  source, time, parser version, approved amount) is part of the comparison, so
  reusing the ID with different provenance is a conflict. Separate captures of
  the same text are separate dated snapshots; there is no content-hash dedup.
- The popup freezes an approved capture (payload, case and item) when Save is
  pressed. Retries and recovery after an uncertain reply reuse that exact
  payload and ID, and the assignment is locked until the outcome is known.
- Order compatibility for captures uses the order in the selected text and the
  order in the source page address, through one rule shared by the popup and
  the service worker (see [capture.md](capture.md#assignment-checks)).

## Persistence and concurrency

- One `chrome.storage.local` key. Every read is validated at runtime
  (`parseStore`). Unknown schema versions and malformed data are shown
  read-only; writes are refused and nothing is reset unless the user explicitly
  erases (which leaves only an empty ledger with a new erase marker).
- Dashboard pages never write storage directly. They send validated commands to
  the service worker, which applies them one at a time to the latest stored
  state and writes. Pages re-render on `chrome.storage.onChanged`, so two open
  dashboards see each other's changes and cannot overwrite them.
- Save reporting follows the `chrome.storage.local.set` contract: a resolved
  `set` is a committed write and is reported as saved; a rejected `set` is not
  committed and is reported as *not saved* (`write_rejected`), with the form
  input kept. There is no read-back after writing, so a failing read can never
  make a committed write look unsaved. A read failure *before* writing is
  reported as "no change was attempted".
- If the dashboard gets no valid reply (`outcome_unknown`, e.g. the message
  channel failed), it does not claim success or failure. It re-reads storage and
  looks for the operation's own ID (entry, void or case ID):
  - found → reported as saved and the form is closed, so a committed receipt is
    never offered for re-entry;
  - not found, or storage unreadable → the input is kept and the user is told a
    retry is safe. A retry reuses the **same** ID, so it is idempotent and can
    never add a second receipt. Nothing is rolled back, deleted or re-issued
    under a new ID. If the change lands later, the open form closes and the
    page says it was saved.
- If the dashboard cannot read storage (for example right after a save), it
  says only that saved data can't be read right now. It does not claim an
  earlier change failed or that storage is unchanged; any save notice above
  still applies, and *Try again* re-reads. The corrupt/unsupported-data screen
  says the dashboard will not reset or overwrite that data and that new changes
  are blocked; it makes no claim about earlier operations.

## Limitations

- Evidence is manual or user-approved selected text; correctness depends on
  what the user records and selects. Capture reads only selected text on
  `amazon.com` / `www.amazon.com` and supports only the documented patterns.
  It has been tested on synthetic fixtures, not on live Amazon pages.
- Items cannot be added to or removed from an existing case yet; order
  reference and item labels cannot be edited after creation.
- Exports: a plain-text case summary and a complete JSON data copy (see
  [export.md](export.md)). A JSON copy can be restored only into a ledger with
  no cases; there is no merge or partial import (see [restore.md](restore.md)).
  Storage is limited to Chrome's 10 MB `storage.local` quota (failed writes
  are reported, not hidden).
- Local data is not encrypted.
- Expected-amount entries cannot be voided; record a new expected amount instead.
- No toolbar badge or reminders.
- The finder searches only order references and item descriptions, with
  plain substring matching (no accent folding, fuzzy matching or saved
  searches). Filters reset when the dashboard is reopened.
- The overview totals are only as complete as the saved evidence; they say
  nothing about refunds that were never recorded.

## Next milestone: capture validation

Task 02 adds the first capture slice: user-selected text, previewed and
explicitly approved, saved as a merchant-report snapshot with provenance and a
stable operation ID. It is **not** automatic reconciliation.

Still to do before any paid positioning:

- validate, on real (user-consented) Amazon US pages, that per-item refund
  status can be selected and parsed reliably, and update the parser patterns
  from that evidence;
- validate the toolbar-click flow manually in desktop Chrome, since automated
  tests use a test copy with fixture-only host access;
- only then consider whole-page extraction and history, and test willingness
  to pay.

Task 03 adds read-only exports from saved evidence (a shareable case summary
and a portable JSON data copy; see [export.md](export.md)). They do not change
the items above: live Amazon compatibility and the real toolbar-grant flow are
still unvalidated, and exports do not establish willingness to pay.

Task 04 adds restoring a JSON backup into an empty ledger (see
[restore.md](restore.md)). It is a recovery path for saved evidence, not a
sync or merge feature, and changes none of the open validation items above.

Task 05 adds a read-only overview and case finder on the dashboard (see
above). It reads existing evidence only and changes none of the open
validation items above: live Amazon compatibility and the real toolbar-grant
flow are still unvalidated.

Until then this should not be presented as a validated or paid product.
