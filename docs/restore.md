# Restoring a local backup (Tasks 04 and 04.1)

Restore recovers saved evidence from a JSON file made with **Download all data
(JSON)** (see [export.md](export.md)), for example in a fresh browser profile.
It is deliberately narrow:

- it writes only into an **unlocked** ledger that has **no cases** (not even
  synthetic demo cases). From 0.7.0 a new installation must complete
  **Protect your records** first (from 0.8.0, after agreeing to the data
  practices; restore neither imports nor implies that agreement), and the restored records are written into
  the encrypted vault ([vault.md](vault.md)); the backup file itself stays
  plaintext;
- it never merges with, replaces, deletes or clears existing cases, and there
  is no erase-and-restore shortcut. To empty a ledger on purpose, use the
  existing **Delete case…** and **Remove synthetic demo** controls (or, only for
  unreadable or locked data, **Erase stored data…**) first;
- it uses no network, no new permission and no backend. All code is bundled.

Code: `src/domain/validate.ts` (`parseBackupEnvelope`, optional `lastRestore`
validation), `src/domain/restore.ts` (pure `decideRestore`),
`src/background/handler.ts` and `messages.ts` (the `restore` request),
`src/export/backup.ts` (`MAX_BACKUP_BYTES`, `restorePayloadDigest`) and
`src/ui/restore.ts` (dashboard panel).

## Supported files

Only the Task 03 backup envelope, format version 1:

```json
{
  "format": "refund-reconciler-backup",
  "formatVersion": 1,
  "exportedAt": "2026-10-10T12:05:01.123Z",
  "store": { "schemaVersion": 1, "revision": 12, "cases": [] }
}
```

- Exactly these four fields. Any other `format`, any `formatVersion` other than
  the number `1`, an extra field, or an `exportedAt` that is not a valid ISO
  timestamp is rejected.
- `store` must pass the same `parseStore` validator as data read from
  `chrome.storage.local` (ledger schema version 1 only): ids, timestamps,
  integer cents within limits, explicit `null` unknowns, unique case/item/entry
  ids, void targets (an earlier evidence entry on the same item), capture
  provenance (supported origin, sanitised path, approved amount text inside the
  excerpt and equal to the entry amount, capture source label), and the
  existing text and item-count limits. Restore additionally requires every
  captured report's `parserVersion` to be a known version.
- The file name and extension prove nothing; only the contents are checked.
- **Input bound:** at most **25 MiB** (`MAX_BACKUP_BYTES`), checked from the
  file's size before any byte is read. Larger files are refused with their
  size and the limit. The file must be UTF-8 (a leading BOM is ignored);
  undecodable bytes, read failures and invalid JSON each give a specific
  error. Note that `chrome.storage.local` itself holds about 10 MB; a valid
  file whose ledger exceeds the quota is refused by storage and reported as
  not restored.
- A valid backup with **no cases** is an informative no-op: nothing is
  written and the revision does not change.

The file is untrusted data. Labels, notes, references, excerpts and the file
name are rendered as text only; source paths are not made into links; nothing
from the file is executed or logged. The parsed file lives only in the open
panel's memory and is discarded on Cancel/Close/Escape or page close.

## Flow in the dashboard

1. **Your data → Restore from JSON…** (or **Restore from a JSON backup…** in
   the empty state of a completely empty ledger) opens the panel.
2. Choose a file with the file input. It is read and validated locally.
   Choosing or replacing a file never writes anything; a newer choice discards
   any older file's pending result.
3. The preview shows the export time, backup format/ledger schema versions,
   the source revision, counts (your cases, synthetic demo cases, items,
   entries including voids, captured reports), a readable case list (demo cases
   are badged), and a collapsed **Show notes, references and captured
   excerpts** section. It explains that records keep their original attribution
   (user-entered or merchant statement), that restoring is not verification of
   money received, and that the file is neither encrypted nor signed by Amazon
   or the extension.
4. The panel freshly reads and validates this browser's saved data. Only a
   readable, supported ledger with zero cases enables **Restore N cases**.
   Existing cases (including demo-only), corrupt, unsupported or unreadable data
   block it with an explanation; they are never treated as empty.
5. **Restore N cases** is the explicit approval. The outcome shown is what is
   actually known (below).

**Event-time protection.** When a storage change event reaches the dashboard
while a preview is open, approval is paused immediately (state "Checking…",
button disabled), before the revalidation read starts. Reads overtaken by a
later change are discarded and repeated (up to three times, then "kept
changing" with **Check again**). The worker re-checks everything at commit time
as well.

**Locking.** Approval freezes one operation: a new random operation id, the
validated payload and the destination state it was approved against
(`expected: { revision, stored, epoch }`, see *Approval token* below). While it is being sent or is uncertain the
file input is disabled, so a later file choice, click or late result cannot
retarget it; results are applied only to the operation that produced them.
Unsaved case/entry forms and their own pending or uncertain save state are not
touched by the panel.

## At the service worker

`{ kind: 'restore', operationId, expected, backup }` is validated again in the
worker (`parseRequest` → `parseBackupEnvelope`), so a forged message cannot skip
validation. Inside the existing serialised queue the worker then re-reads and
validates the destination immediately before deciding:

| Destination | Result |
| --- | --- |
| unreadable / corrupt / unsupported | refused (`storage_error`, `storage_unreadable`, `storage_unsupported`); nothing written |
| `lastRestore.operationId` equals this id, same payload digest | `duplicate`: already restored, nothing written (even if cases were edited or deleted since) |
| same id, different payload digest | `conflict`; nothing written |
| backup has no cases | `unchanged`; nothing written |
| has any case | `restore_not_empty`; nothing written |
| `revision`, key presence or `ledgerEpoch` differs from `expected` | `restore_stale`; nothing written |
| otherwise | one `set()` of the restored ledger plus its receipt → `applied` |

Imported cases are written exactly as validated — ids, `createdAt`/`updatedAt`,
`recordedAt`, recording order, cents, `null` unknowns, notes, references,
voids, expectation history, demo flags and capture provenance. Entries are
**not** replayed as `recordEntry` commands and historical captures are **not**
re-parsed (a stored `amazon-us-selection-1` capture that the current parser
would refuse is restored as stored). Derived financial state therefore matches
the source.

### Approval token and the erase marker

A restore is approved against `expected = { revision, stored, epoch }`:
the destination's revision, whether the ledger key existed, and its
`ledgerEpoch` (or `null`). The worker applies the restore only if all three
still match, inside its serialised queue, so the check does not depend on any
dashboard listener or in-memory state.

**Explicit erase does not remove the key.** It replaces whatever is stored —
including corrupt or unsupported data, which is never read or trusted for
this — with one `set()` of:

```json
{ "schemaVersion": 1, "revision": 0, "cases": [], "ledgerEpoch": "<new random UUID>" }
```

All cases, items, entries, notes, references, excerpts, the old `lastRestore`
receipt and its source metadata are gone; the only thing kept is the opaque
random marker, which contains no user data. Every erase writes a **new**
marker, so the token after an erase (`stored: true`, the new epoch) can never
equal any token from before it — including the `{ revision: 0, stored: false,
epoch: null }` token of a never-written profile, and the token of an earlier
erase cycle. Unchanged old requests (a committed request replayed verbatim, or
a first request held before delivery while another view creates and erases
data) are therefore `restore_stale`. If storage rejects the erase write, the
original data stays as it was and the erase is reported as failed.

Lifecycle of `ledgerEpoch` (optional, validated on every read and in restore
messages as an id of at most 64 `[A-Za-z0-9_-]` characters):

- absent on ledgers that were never erased (including all Task 01–03 data);
- created only by an explicit erase, new on every erase;
- carried unchanged by every other write: entries, voids, case deletion, demo
  load/removal and restore commits;
- exported with the ledger; a `ledgerEpoch` inside an imported backup is
  validated and ignored. The restored ledger keeps the **destination's**
  marker (or none), so another profile's marker never becomes destination
  authority.

Because it lives in `chrome.storage.local`, the protection survives handler
recreation, worker restarts and browser/profile restarts (tested with a full
browser relaunch). Selecting, previewing or cancelling a file still reads only;
a never-written profile stays without a key until a real write.

### Revision and bookkeeping

- The restored ledger gets `revision = destination revision + 1` (the usual
  "every write increments" rule). The backup's own revision is kept only as
  `lastRestore.sourceRevision`; the destination counter never rolls back.
- `lastRestore` (optional, schema 1 unchanged) records `operationId`,
  `payloadSha256` (SHA-256 of the canonical JSON of `[exportedAt, cases]`),
  `restoredAt`, `restoredRevision`, `sourceExportedAt`, `sourceRevision` and
  `caseCount`. It is written in the **same stored record and the same write**
  as the cases, so a committed restore is always recognisable and a failed write
  leaves neither. It is validated on every read (exact fields, hex digest,
  `1 ≤ restoredRevision ≤ revision`). Only the most recent restore is kept.
- A `lastRestore` inside an imported file belongs to another ledger. It is
  validated but discarded; the destination gets its own receipt with the new
  operation id, so imported bookkeeping can never pass as proof of a new
  restore. Later exports include the destination's receipt, so the complete
  ledger stays portable.

## Outcomes and retries

- **Applied:** "Restore complete … (saved-data revision N)". This comes from
  the worker's reply after the write resolved; no post-write read can turn it
  into "not restored". The completed operation is never offered again.
- **Completion freshness.** Storage events can arrive while the reply is still
  pending (they are not acted on while sending), so after any completion the
  panel does a new, generation-checked read. Current data "still matches" only
  if it carries this operation's receipt at the revision the restore wrote
  (every later write changes the revision; erase removes the receipt):
  - mismatch → "Saved data has changed since this restore, so it may no longer
    match the backup file" (final for that panel);
  - read failed, or storage kept changing for three reads → the completion
    stands, and the panel says current saved data could not be verified;
  - match from a read that no storage change overtook → "Current saved data
    still matches this restore". A read overtaken by a change is discarded and
    can never clear the warning; the restore's own write event alone does not
    count as a change. Each later event marks it "checking" at event time and
    reads again.
- **Definitely not restored** (`write_rejected`, `restore_not_empty`,
  `restore_stale`, read/validation refusals): the message says nothing was
  restored, the preview stays, the destination is re-checked, and restoring
  again is a new explicit click (new operation id).
- **Reply lost** (`outcome_unknown`): the panel keeps the same frozen
  operation and looks for **its own operation id** in `lastRestore` — never at
  case counts, labels or amounts.
  - found → "Restore complete: the extension's reply was lost, but this
    restore's own operation id is in your saved data … It was not applied
    twice";
  - not found and no storage change observed since sending → still uncertain;
    **Check and retry restore** resends exactly the same operation (same id,
    payload and `expected`), which the worker either applies once or recognises;
  - saved data cannot be read → still uncertain; it never claims nothing
    changed;
  - not found but saved data **changed** after sending → the approval is
    withdrawn without resending (see below).

### Deletion, erase and delayed retries

- **Deleting restored cases** (or removing the demo) keeps `lastRestore` in the
  ledger, so a delayed retry of that operation is answered `duplicate` and
  nothing is resurrected.
- **Erase stored data** (0.7.0: typed `ERASE`, available while locked or
  unreadable) removes the vault with its receipt, revokes the session and
  writes a fresh erase marker; from 0.8.0 it also removes the data-practices
  agreement, and is available before agreement too. After agreeing again, the
  next **Protect your records** creates a new
  vault whose ledger carries that marker as its `ledgerEpoch`. The worker
  refuses every request approved before the erase (`restore_stale`), whether
  it is a retry, a verbatim replay of a committed request, or a first request
  whose delivery was delayed. The dashboard additionally withdraws an
  uncertain operation without resending if saved data changed after it was
  sent and its receipt is not there. From 0.7.0, an erase or Lock in any view
  also **closes every open restore panel at once** (with the chosen file's
  contents and any approval), so a late reply never reopens it; a restore the
  worker already committed is not undone. A new restore requires a fresh
  destination read and a new click (new operation id and the post-erase
  token); it applies once.
- **Tokens from 0.7.0.** A protected ledger always exists, so its approval
  token is `{ revision, stored: true, epoch }` with the vault's own epoch.

## What was tested

Unit tests (`tests/unit/restore.test.ts`): envelope and ledger validation
(wrong format/version, extra fields, timestamps, unsupported schema, invalid
money, duplicate ids, bad void references, bad provenance, unknown parser
version, text limits, receipt validation), `decideRestore` (revision, receipt,
imported receipt discarded, not-empty/stale/conflict/no-op, identical derived
state), the digest, and the handler (forged messages, single application,
identical retry after a later edit and with a **fresh handler instance over the
same storage** to model a worker restart, rejected write then retry, corrupt/
unsupported/unreadable destinations, concurrent restores, deletion/erase), the
erase marker (verbatim replay of a committed first restore across three erase
cycles with recreated handlers, a late first request after create+erase cycles,
marker preserved through mutations/deletion/restore and never imported, marker
validation), and erase of unreadable data with failing reads plus a rejected
erase write (`tests/unit/handler.test.ts`).

Browser tests (`tests/e2e/restore.spec.ts`, built extension in Playwright's
Chromium, real file input, real downloads, real worker messaging and storage):

1. export a rich synthetic ledger with the real Download JSON flow, save the
   real file, restore it through the file input in a **second empty profile**,
   compare stored data and derived figures, then re-export a real download and
   validate it;
2. that ledger has manual receipts/recharges, a void, expectation changes, an
   unknown amount, current and historical captures (one the current parser
   refuses) and synthetic demo cases;
3. preview, cancel, Escape and file replacement write nothing; hostile text is
   literal; an empty backup is a no-op in the panel and at the worker;
4. malformed JSON, non-UTF-8, an oversized file, wrong envelope/version,
   invalid money, duplicate ids, a bad void reference and bad provenance in the
   UI, and forged worker messages;
5. demo-only data blocks restore; corrupt, unsupported and failed reads (page
   and worker) block it and are left unchanged;
6. a case created by a second dashboard after preview: approval is paused at
   event time (asserted while the revalidation read is held) and the worker
   refuses a stale attempt; also a restore already in flight;
7. two concurrent restores from two dashboards: one complete ledger, the other
   refused;
8. a committed restore with a lost reply while page reads fail stays uncertain,
   is not resent after a change, then recovers by its operation id without
   disturbing a later entry; a lost reply with readable storage reports
   completion; a request lost before delivery retries with the same id;
9. a rejected write (injected in the worker) keeps the preview and storage
   unchanged, the next click succeeds, and conflicting reuse of the id is
   refused;
10. after deleting all cases, a delayed retry is recognised and nothing is
    resurrected; after Erase, the uncertain operation is withdrawn without
    resending, the old approval is refused at the worker, and a new restore uses
    a new id;
11. unsaved entry drafts survive an open restore panel and storage changes.

The hostile file name `<b>second<i>.json` is supplied through the real file
input as an in-memory Playwright file payload (it is not a valid path on
Windows); ordinary names still use real files on disk and real downloads.

Task 04.1 browser regressions (`tests/e2e/restore-races.spec.ts`), with
requests captured from the real Restore UI and replayed unchanged:

- a committed first restore in a never-written profile, replayed verbatim after
  each of three erases through the real Erase UI and after a **full browser
  relaunch** of the same profile: `restore_stale` every time, storage stays the
  erased marker; a fresh explicit restore then applies once, a replay of it is
  `duplicate`;
- a first restore held before delivery while another dashboard loads data and
  erases twice: released, it is refused and nothing is restored; a new explicit
  restore then succeeds;
- a successful reply held **after the real commit** while another dashboard
  adds an entry, deletes the restored case, or erases (each asserted as seen by
  the first dashboard before release): completion is reported with the
  "changed since" warning and no further restore write; with no later change it
  reports "still matches"; a failed completion read reports "could not be
  verified"; a held completion read overtaken by a change cannot clear the
  warning.

These tests were checked to fail with the pre-04.1 code (key removal on
erase, and the old completion handling).

Service-worker termination: in Task 09 an isolated worker stop through the
DevTools protocol (`ServiceWorker.stopAllWorkers`, confirmed by Chrome's own
running-status events) was exercised for the vault session in
`tests/e2e/vault.spec.ts`; the restore tests themselves still model a restart
by recreating the handler (unit) or relaunching the browser. The worker keeps
no restore state in memory; recognition and erase protection rely only on
stored data. The restore browser tests ran on Linux Chromium only; Windows CI
runs the unit tests and the update checks.

From 0.7.0 these tests run against the encrypted vault: each profile first
completes **Protect your records** through the real UI, seeded ledgers are
written as vault ciphertext by a test-side encoder, and stored data is read
back by a test-side decoder (`tests/e2e/vault-helpers.ts`). Where an erase
used to leave the restore panel open, the adapted tests assert that it is
closed and that a late reply cannot reopen it.

## Limitations

- Restore only into an empty, unlocked ledger; no merge, partial import, or
  selection of individual cases.
- The file is checked for structure only. It is not encrypted or signed, so an
  edited file that is still well-formed is restored as it is.
- Encryption adds about a third to the stored size, so the vault holds a
  ledger of about 7.5 MB of JSON within the 10 MB quota.
- Only the most recent restore is remembered (`lastRestore`).
- Very large ledgers are bounded by Chrome's 10 MB `storage.local` quota
  (see above).
- Real Amazon refund-wording compatibility of capture remains untested; the
  toolbar grant was later owner-reported as passing (see
  [validation.md](validation.md)).
