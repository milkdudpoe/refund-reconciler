# Restoring a local backup (Task 04)

Restore recovers saved evidence from a JSON file made with **Download all data
(JSON)** (see [export.md](export.md)), for example in a fresh browser profile.
It is deliberately narrow:

- it writes only into a ledger that has **no cases** (not even synthetic demo
  cases);
- it never merges with, replaces, deletes or clears existing cases, and there
  is no erase-and-restore shortcut. To empty a ledger on purpose, use the
  existing **Delete case…** and **Remove synthetic demo** controls (or, only for
  unreadable data, **Erase stored data…**) first;
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
(`expected: { revision, stored }`). While it is being sent or is uncertain the
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
| `revision` or key presence differs from `expected` | `restore_stale`; nothing written |
| otherwise | one `set()` of the restored ledger plus its receipt → `applied` |

Imported cases are written exactly as validated — ids, `createdAt`/`updatedAt`,
`recordedAt`, recording order, cents, `null` unknowns, notes, references,
voids, expectation history, demo flags and capture provenance. Entries are
**not** replayed as `recordEntry` commands and historical captures are **not**
re-parsed (a stored `amazon-us-selection-1` capture that the current parser
would refuse is restored as stored). Derived financial state therefore matches
the source.

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
  into "not restored". The completed operation is never offered again. If saved
  data later changes, the panel adds that it may no longer match the backup.
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
- **Erase stored data** removes the whole key, receipt included. The worker
  cannot distinguish an erased ledger from one that never existed, so the
  dashboard protects against that case: if any storage change was observed
  after the request was sent and its receipt is not in saved data, the
  operation is withdrawn ("it may or may not have been restored before saved
  data changed") and never resent. A new restore requires a fresh destination
  check and a new click, which creates a new operation id. At the worker,
  an approval made against a written ledger (`stored: true`) never matches an
  erased, missing key, and any approval with an old revision is `restore_stale`.
- Remaining gap, by design of the existing counter: a hand-crafted message from
  an extension page that targets a missing key (`stored: false, revision: 0`)
  is processed like any new restore. That is equivalent to a new approval (only
  the extension's own pages can send messages), and the dashboard never sends
  one after observing a change.

## What was tested

Unit tests (`tests/unit/restore.test.ts`): envelope and ledger validation
(wrong format/version, extra fields, timestamps, unsupported schema, invalid
money, duplicate ids, bad void references, bad provenance, unknown parser
version, text limits, receipt validation), `decideRestore` (revision, receipt,
imported receipt discarded, not-empty/stale/conflict/no-op, identical derived
state), the digest, and the handler (forged messages, single application,
identical retry after a later edit and with a **fresh handler instance over the
same storage** to model a worker restart, rejected write then retry, corrupt/
unsupported/unreadable destinations, concurrent restores, deletion/erase).

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

Not tested in the browser: a real service-worker restart (the DevTools
`stopAllWorkers` command also closed the test page in this harness). The worker
keeps no restore state in memory; recognition relies only on the stored
receipt, which the unit tests exercise with a fresh handler instance.

## Limitations

- Restore only into an empty ledger; no merge, partial import, or selection of
  individual cases.
- The file is checked for structure only. It is not encrypted or signed, so an
  edited file that is still well-formed is restored as it is.
- Only the most recent restore is remembered (`lastRestore`).
- Very large ledgers are bounded by Chrome's 10 MB `storage.local` quota.
- Live Amazon compatibility of capture and the real toolbar-grant flow remain
  unvalidated (unchanged by this task).
