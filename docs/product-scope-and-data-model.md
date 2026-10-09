# Product scope and data model (Task 01)

## Scope

- **Retailer / currency:** Amazon US, USD only.
- **What it does:** keeps a per-item evidence log for returns and derives which
  expected refunds are confirmed, partially confirmed, unconfirmed, reopened by a
  recharge, or exceeded — so the user knows what needs review.
- **What it does not do:** move money, contact merchants, file disputes, read
  email or bank data, scrape pages, or decide legal entitlement. Differences are
  shown as *unresolved expected amounts* or *records needing review*, never as
  money guaranteed to be owed.
- **Evidence in Task 01** is entered manually or comes from a synthetic demo the
  user must opt into. The demo is stored with `isDemo: true`, labelled
  "Synthetic", and listed separately.

## Data model

All amounts are **non-negative safe integer cents**. User input is parsed from
the digit string (with BigInt) and rejected if malformed, negative, more precise
than cents, or above $1,000,000,000.00. Sums use checked integer addition.

```
StoreData { schemaVersion: 1, revision, cases[] }
CaseRecord { id, retailer: 'amazon_us', orderRef | null, currency: 'USD',
             isDemo, createdAt, updatedAt, items[], entries[] }
ItemRecord { id, label, createdAt }
Entry (append-only; common fields: id, itemId, recordedAt, occurredOn | null, source, note)
  expectation      amountCents | null   user-approved expected refund; null = unknown
  merchant_report  amountCents, reference | null   merchant's reported issued total (snapshot)
  receipt          amountCents > 0, reference | null   user confirms money received
  recharge         amountCents > 0, reference | null   user records money taken back
  void             targetEntryId, note = reason   marks an earlier report/receipt/recharge mistaken
```

Entries are never edited or removed (except by deleting the whole case).
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

## Persistence and concurrency

- One `chrome.storage.local` key. Every read is validated at runtime
  (`parseStore`). Unknown schema versions and malformed data are shown
  read-only; writes are refused and nothing is reset unless the user explicitly
  erases.
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

- Manual entry only; correctness depends on what the user records.
- Items cannot be added to or removed from an existing case yet; order
  reference and item labels cannot be edited after creation.
- No import/export or backup. Storage is limited to Chrome's 10 MB
  `storage.local` quota (failed writes are reported, not hidden).
- Local data is not encrypted.
- Expected-amount entries cannot be voided; record a new expected amount instead.
- No toolbar badge or reminders.

## Next milestone: capture validation

The product's eventual paid value depends on **automatic, user-approved capture
of Amazon US order/return/refund status** feeding merchant-report observations
(with stable observation IDs) into this engine. That is not built. The next task
should prove, on real (user-consented) Amazon US pages, that per-item refund
status can be captured reliably enough to detect partial refunds and later
recharges — and only then test willingness to pay. Until then, this foundation
should not be presented as a validated or paid product.
