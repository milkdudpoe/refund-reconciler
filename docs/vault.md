# Encrypted local ledger (vault format 1)

From version **0.7.0**, Refund Reconciler keeps the saved ledger encrypted in
`chrome.storage.local`. The key that decrypts it is protected by a passphrase
the user chooses. This page describes the storage format, the key and session
lifecycle, migration from the plaintext storage of earlier versions, how
failures are handled, and what the protection does **not** cover.

It describes behaviour that is implemented and tested (see
[Evidence](#evidence)). It is not a security certification, not a claim of
FIPS 140 validation, and not a statement that any store policy is met.

Sources consulted (2026-10-10):

- [W3C Web Cryptography API](https://w3c.github.io/webcrypto/) (Editor's
  Draft, 11 August 2026): §29 AES-GCM (`AesGcmParams`: `iv`,
  `additionalData`, `tagLength`, default and maximum 128 bits), §34 PBKDF2
  (`Pbkdf2Params`: `salt`, `iterations`, `hash`; zero iterations is an error),
  `wrapKey`/`unwrapKey`, and the `extractable` key attribute. The draft says
  it must be cited as a work in progress.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html):
  "PBKDF2-HMAC-SHA256: 600,000 iterations", a unique salt per password, and
  benchmarking so that a derivation "should take less than one second". It
  ranks Argon2id, then scrypt, then bcrypt above PBKDF2, and prefers PBKDF2
  where FIPS-140 validated implementations are required.
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
  (last updated 2026-09-11): `storage.session` items "are stored in-memory
  and will not be persisted to disk" and are cleared when "the extension is
  disabled, reloaded, updated, and when the browser restarts"; both areas
  have a 10 MB quota; `setAccessLevel()` with `TRUSTED_CONTEXTS` restricts an
  area to contexts "originating from the extension itself". The page does not
  say whether a resolved `set()` means the write is durable; this extension
  keeps its earlier rule that a resolved `set()` is treated as committed.

## Why PBKDF2

The browser offers no memory-hard password KDF (Argon2id, scrypt) natively,
and the task forbids custom cryptography or a crypto dependency. PBKDF2 with
HMAC-SHA-256 is available in WebCrypto everywhere this extension runs, and
600,000 iterations is OWASP's current recommendation for it. This is a
deliberate native-browser choice, not a claim that PBKDF2 is the best or the
only suitable KDF. A later format version can raise the work factor or change
the KDF; format 1 accepts exactly these parameters and nothing else.

## Storage layout

| Area | Key | Contents | Private? |
| --- | --- | --- | --- |
| `storage.local` | `refundReconciler.vault` | The vault envelope below | Ciphertext only |
| `storage.local` | `refundReconciler.migration` | `{ format: "refund-reconciler-migration", formatVersion: 1, phase: "candidate" \| "verified", vaultId }` while a migration is in progress | No |
| `storage.local` | `refundReconciler.erased` | `{ format: "refund-reconciler-erased", formatVersion: 1, epoch }` after an explicit erase | No (a random id) |
| `storage.local` | `refundReconciler.store` | The **plaintext** schema-1 ledger of versions before 0.7.0. Read only for migration; removed after a verified migration | Yes (legacy) |
| `storage.session` | `refundReconciler.session` | `{ format: "refund-reconciler-session", formatVersion: 1, vaultId, generation, key }` while unlocked | **Yes: the data key** (memory only) |
| `storage.session` | `refundReconciler.sessionGeneration` | A random id changed by every Lock and erase | No |

Both areas are restricted to `TRUSTED_CONTEXTS` before any request is
handled (`src/background/service-worker.ts`). If either restriction fails,
every request is refused with `storage_unavailable` and nothing is read,
written, unlocked or kept in session storage.

The plaintext ledger schema (version 1, `src/domain/types.ts`) and the JSON
backup format (version 1, `src/export/backup.ts`) are unchanged. The vault
envelope has its own version.

## The envelope

```jsonc
{
  "format": "refund-reconciler-vault",
  "formatVersion": 1,
  "vaultId": "<random id>",
  "kdf": { "name": "PBKDF2-HMAC-SHA-256", "iterations": 600000, "salt": "<16 bytes, base64>" },
  "keyWrap": { "cipher": "AES-256-GCM", "iv": "<12 bytes>", "wrappedKey": "<32-byte key + 16-byte tag>" },
  "payload": { "cipher": "AES-256-GCM", "iv": "<12 bytes>", "ciphertext": "<UTF-8 StoreData JSON + 16-byte tag>" }
}
```

- **Data key:** a random 256-bit AES-GCM key from `crypto.subtle.generateKey`,
  created once per vault.
- **Wrapping key:** PBKDF2-HMAC-SHA-256 over the passphrase's UTF-8 bytes,
  with a fresh random 16-byte salt per vault and 600,000 iterations. It can
  only wrap and unwrap, and is never extractable or stored.
- **Key wrap:** the data key is wrapped with AES-GCM (`wrapKey('raw', …)`)
  under the wrapping key: fresh 12-byte IV, 128-bit tag.
- **Payload:** the **entire** validated `StoreData` JSON (every case, entry,
  note, reference, capture excerpt, `lastRestore` and `ledgerEpoch`) is
  encrypted with AES-GCM under the data key. Every write uses a fresh random
  12-byte IV, including a retry of a rejected write. The data key changes
  only with a new vault, so random 96-bit IVs stay far below the collision
  bound that NIST SP 800-38D (cited by the WebCrypto draft) sets for one key.
- Base64 is standard, padded and canonical; non-canonical text is rejected.

**Authenticated data.** Each encryption has explicit additional
authenticated data: the UTF-8 bytes of a JSON array of strings and safe
integers (no objects, so the encoding is deterministic):

| Context | AAD |
| --- | --- |
| Key wrap | `["refund-reconciler-vault", 1, "key-wrap", vaultId, "PBKDF2-HMAC-SHA-256", 600000, salt, "AES-256-GCM"]` |
| Payload | `["refund-reconciler-vault", 1, "ledger-payload", vaultId, "AES-256-GCM"]` |

The third element separates the two contexts, so a wrapped key can never be
accepted as a payload or the reverse. Changing the format, version, vault id,
KDF name, iteration count, salt or cipher makes authentication fail.

**No private metadata.** The envelope's plaintext fields are the format,
version, vault id, KDF parameters, ciphers, IVs and ciphertext. No note,
reference, excerpt, amount, case list, count, revision or restore receipt is
outside the ciphertext. The ciphertext length does reveal the approximate
size of the ledger.

**Not rollback protection.** Authentication proves that a payload was written
under this vault's key. It does not prove that it is the *latest* payload:
someone who can write the profile's files could put back an older complete,
valid envelope of the same vault, and it would decrypt. Nothing in format 1
detects that.

**Strict validation before work** (`src/vault/format.ts` `parseEnvelope`):
exact field sets, the format and version, exactly the KDF name and 600,000
iterations (an attacker-chosen huge or tiny count is refused before any
derivation), the cipher names, exact byte lengths (salt 16, IVs 12, wrapped
key 48), canonical base64, a ciphertext of at least 17 bytes, and at most
16 MiB of base64 text. A different integer format version, KDF or cipher is
reported as *unsupported*; anything else malformed is *corrupt*. Decrypted
bytes must be strict UTF-8 (`TextDecoder` with `fatal: true`), parse as JSON
and pass the existing `parseStore`. An authenticated payload that fails
domain validation is **unreadable**, never a new or empty ledger. Nothing is
repaired, and historical captures are never re-parsed.

**Capacity.** Base64 adds a third, so a ledger of about 7.5 MB of JSON fills
the 10 MB `storage.local` quota (before 0.7.0, about 10 MB). A rejected write
is reported as not saved, as before. `unlimitedStorage` is not requested.

## Passphrase rules

`src/vault/passphrase.ts`, enforced by the service worker and checked by the
page for immediate feedback:

- at least **12 Unicode code points** and at most **1,024 bytes** of UTF-8;
- used **exactly as typed**: never trimmed, case-folded, Unicode-normalised or
  truncated. "é" typed as one code point and as "e" plus a combining accent
  are different passphrases;
- a string with a lone UTF-16 surrogate (which `TextEncoder` would silently
  replace) is refused rather than transformed;
- no character-class rules; the setup screen encourages a long, unique phrase.

The fields allow pasting and have a **Show passphrase** toggle. The page reads
the value once, clears the fields immediately, and sends it to the service
worker in one runtime message. The passphrase is never stored, logged, put in
a URL or kept in other page state. No extension page registers a
`runtime.onMessage` listener, so only the service worker receives it.

## Key and session lifecycle

- **Unlock** derives the wrapping key, unwraps the data key and decrypts the
  payload. The data key is then kept in the service worker's memory (as a
  non-extractable copy) and, so that a suspended worker can resume without
  the passphrase, as raw bytes in `chrome.storage.session` bound to the vault
  id and the current session generation.
- A **service-worker restart** within the same browser session re-reads that
  session record: the records stay unlocked.
- A **browser restart**, an **extension reload or update**, or disabling the
  extension clears `storage.session`, so the passphrase is needed again.
- **Lock now** writes a new session generation and removes the session
  record. An older record (for example one written by a slow unlock) names
  the old generation and is never accepted again.
- **Erase** also revokes the session, and every new vault gets a new vault id,
  so no earlier session record is ever accepted for it.
- Nothing key-related is persisted beside the ciphertext: the wrapping key
  is never stored, and the data key exists on disk only wrapped.

**Honest limits of memory.** While unlocked, decrypted records exist in the
service worker's and open pages' memory, and the raw data key exists in
`storage.session`, which Chrome keeps in memory. JavaScript cannot guarantee
that memory is securely erased; Lock and erase drop every reference this
extension holds, but copies may remain in the browser's memory until it is
reused.

## Ordering and concurrency

Every request (reads, changes, restore, setup, migration, unlock, Lock,
erase) runs through **one queue in the service worker**, one at a time in
arrival order (`src/background/handler.ts`):

- Each change is applied to the latest saved ledger and encrypted with a
  fresh IV, in one `set()`. Stable operation ids, duplicate detection,
  restore receipts and the destination revision/epoch checks are unchanged.
- A change queued **before** Lock completes normally: **an approved write that
  commits before Lock finishes is not undone by Lock.** Every request queued
  **after** Lock finds the records locked.
- A slow unlock or encryption racing Lock or erase cannot restore a revoked
  session: Lock and erase run after it and revoke what it installed, and a
  late session record carries the old generation.

## What pages do

Pages never read `chrome.storage` and never hold a key. The dashboard and
popup ask the service worker for the state (`read`), validate every reply at
runtime (an `ok` ledger passes `parseStore` again in the page), and render
only the vault screens unless the state is unlocked. They listen only to
`chrome.storage.local.onChanged` (never the session area, which holds the
key) and to a data-free `BroadcastChannel` message from the worker after
Lock, unlock, setup, migration and erase.

| State | Dashboard | Popup |
| --- | --- | --- |
| `setup_required` | **Protect your records** | Open dashboard to set up |
| `migration_required` / `migration_pending` | Migration screens (plaintext backup available) | Open dashboard to protect your records |
| `locked` | Unlock, help, **Erase stored data…** | **Open dashboard to unlock** |
| `ok` (unlocked) | The ledger, with **Lock now** | Capture |
| `vault_unreadable`, `inconsistent`, plaintext `corrupt`/`unsupported_version` | Explanation and **Erase stored data…** | Open dashboard |
| `storage_error`, `storage_unavailable` | Explanation and Try again | Open dashboard |

Replies are never applied out of order. The popup numbers its reads and
applies a reply only if it is newer than the last one applied and was sent
after the last change signal; the dashboard's ledger reads are superseded the
same way. So a reply that was already on its way when Lock or erase happened
can never put the old state back. The pre-migration plaintext backup is
abandoned on any state change, and the allowed state is checked again
immediately before its download starts.

On Lock or erase, every open view at once forgets decrypted records, open
forms and drafts, search text, the export panel with its prepared text, the
restore panel with the chosen file, and any capture preview. Work started
before (a read, a copy or download about to start, a restore or save reply)
is discarded when it arrives. Copy and Download re-check with the worker
**when pressed**. A download already requested, text already on the
clipboard and a save already committed cannot be recalled. While the records
are locked or a setup or migration is pending, the popup does not look up the
tab's address, read a selection or inject anything.

## Setup

Setup is the first screen of a fresh installation, before any ledger (real,
demo or restored) can exist. It requires the passphrase twice and a ticked
acknowledgment that there is no recovery. It creates a new vault whose
ledger is empty with a fresh random `ledgerEpoch` (the erase marker's epoch,
after an erase). Results: **unlocked**; **protected but locked** (the vault
was written but the session could not be kept: unlock to continue); or
nothing written (`write_rejected`, `session_unavailable`).

## Migration from plaintext (0.5.0 and 0.6.0 data)

Valid schema-1 data under `refundReconciler.store` is **never** encrypted
silently with an invented passphrase: the dashboard shows **Protect your
existing records**. Before migrating, **Download plaintext backup (JSON)**
gives a complete format-1 backup of the validated ledger (the one read-only
exception). Changes, capture, restore and the demo are blocked until
migration finishes. Unreadable or unsupported plaintext data is kept intact,
shown read-only and only erased on typed confirmation.

Inside the queue, migration:

1. re-reads and validates the latest plaintext original;
2. checks that the encrypted copy fits beside it under the existing quota
   (otherwise `insufficient_space`, nothing written);
3. writes the marker `phase: "candidate"` with the new vault id;
4. writes the candidate vault (the original ledger, unchanged, encrypted);
5. reads the original, vault and marker back, decrypts the vault and compares
   it with the original **field for field**;
6. writes the marker `phase: "verified"`;
7. removes the plaintext original;
8. removes the marker;
9. keeps the new session.

Every id, timestamp, source, note, reference, void, demo flag, capture
provenance and parser version, the revision, `lastRestore` and `ledgerEpoch`
are preserved exactly. No financial adjustment is made and history is not
normalised.

What a restart finds, and what happens:

| Stored | State | Next step |
| --- | --- | --- |
| Plaintext only | `migration_required` (legacy) | Migrate |
| Plaintext + candidate marker, no vault | `migration_required` (interrupted) | Migrate again |
| Plaintext + marker + unreadable candidate | `migration_required` (candidate unreadable) | Start again (replaces only the unverified copy) |
| Plaintext + marker + readable candidate | `migration_pending` | Enter the migration passphrase: verify, then finish steps 6–8. Or explicitly **start again with a new passphrase** while the original is intact |
| Vault + verified (or leftover) marker, no plaintext | Completed vault (locked/unlocked) | The marker is removed on the next unlock |
| Vault only | Completed vault | — |
| Candidate and plaintext disagree | `migration_blocked` reply, still pending | Neither copy is changed or preferred; download the plaintext backup, start again or erase |
| Vault + plaintext, no marker; damaged marker; marker naming another vault | `inconsistent` | Nothing is changed; plaintext backup (if readable) and erase are offered |

Completion is never inferred from a failed read or a missing reply. A pending
migration is never treated as protected, and the page re-reads the state
after any lost reply. Reply meanings: **unlocked** (finished), **protected
but locked** (finished, session not kept), `migration_unverified` (candidate
written, not checked; original kept), `migration_blocked` (copies differ),
`migration_incomplete` (verified, plaintext not yet removed), or a
`write_rejected` / `insufficient_space` with nothing migrated.

**What migration does not do.** It protects the **current** storage and every
future write. It does not remove older plaintext bytes that Chrome's own
database and log files may still hold from before migration, and it cannot
affect plaintext exports saved earlier. No secure-wipe, profile-deletion or
database-compaction workaround is attempted, and none is claimed.

## Wrong passphrase, damage and erase

- A wrong passphrase and a damaged wrapped key (or its IV or authenticated
  metadata) both fail AES-GCM authentication. The message says the two
  cannot be told apart and allows retrying. Nothing changes.
- If the key unwraps but the payload fails authentication or validation, the
  records are **unreadable**: nothing is reset, no new ledger is created, and
  writes stay blocked.
- **Erase stored data…** is available while locked (under **Forgot your
  passphrase?**), while unreadable, inconsistent or migration-blocked. It
  requires typing `ERASE`. It revokes the session, removes the vault, the
  plaintext ledger and the migration marker in one `remove()`, then writes a
  fresh erase marker. A rejected removal is reported as "may be unchanged";
  a missing marker is reported as `erase_incomplete`, not as success. After
  an erase, earlier restore approvals cannot succeed: the new vault has a new
  id and a new ledger epoch.
- There is **no recovery service and no passphrase change** in 0.7.0. A
  forgotten passphrase means: erase, set a new passphrase, and restore a
  plaintext JSON backup saved earlier.

## Backups, summaries and the clipboard

JSON backups stay complete **plaintext** format-1 files of the decrypted
schema-1 ledger, with no key, passphrase or vault metadata. They restore only
into an empty, unlocked ledger, with the same digest and receipt rules.
Summaries and copied text are plaintext too. All of them are blocked while
locked; the pre-migration backup is the documented exception.

## Threat model

Protects against someone who obtains a copy of the profile's extension
storage files (a stolen or shared disk, a profile backup, another OS account
reading files) **without the passphrase**, for the current ledger and every
later write.

Does not protect against: anyone using the browser while the records are
unlocked; malware or a keylogger on the computer; a weak or reused
passphrase; plaintext exports, summaries and clipboard contents; plaintext
left in Chrome's files by versions before 0.7.0; replay of an older complete
vault envelope; or memory inspection while unlocked. Extension pages and the
service worker are one trust domain: the service-worker boundary keeps keys
and decryption in one place, but it is an architectural boundary, not
isolation from the extension's own pages.

## Evidence

- Unit tests (real WebCrypto, production work factor): `tests/unit/vault-crypto.test.ts`
  (envelope bounds, AAD, unique IVs, tampering, strict UTF-8/JSON/domain
  validation, passphrase rules), `tests/unit/handler.test.ts` (setup, Lock,
  sessions, restarts, races, erase, access-level failure),
  `tests/unit/vault-migration.test.ts` (every migration storage step rejected,
  interrupted and committed-then-interrupted, with a recreated worker),
  `tests/unit/restore.test.ts` and `tests/unit/capture-ledger.test.ts`.
  Storage areas there are in-memory fakes (`tests/unit/vault-fakes.ts`).
- Browser tests: `tests/e2e/vault-races.spec.ts` (stale replies after Lock,
  erase, unlock and migration, in the popup and for the plaintext backup) and
  `tests/e2e/vault.spec.ts` (setup, canary and key scan of the
  closed profile's files, multi-view Lock, stale work after Lock, worker
  stop/restart via the DevTools protocol, full browser restart, tampering,
  locked erase, migration and interrupted verification, legacy-backup
  restore), plus every earlier browser test running against the vault.
- Update checks: `tests/update/same-installation-update.spec.ts` builds 0.5.0
  (`b323930`) and 0.6.0 (`60e330b`) from source and updates each in place to
  the 0.7.0 ZIP.

KDF timing measured in this task (each is one derivation plus unwrap or
wrap; reported, not asserted):

| Environment | Setup | Unlock |
| --- | --- | --- |
| Node 22.22.0, Linux x64, Intel Xeon 2.1 GHz (4 vCPU) cloud container, `tests/unit/vault-crypto.test.ts` | 144 ms | 107 ms |
| Playwright Chromium (build 1194), same container, click to unlocked dashboard (includes messaging and rendering) | 416–421 ms | 422 ms |

Real-world timing on users' computers has not been measured. The work factor
is never lowered for tests or the UI.
