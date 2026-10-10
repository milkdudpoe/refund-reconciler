# Data practices disclosure and agreement (0.8.0)

From version **0.8.0**, Refund Reconciler explains how it handles your data
and asks for an explicit **Agree and continue** before anyone can enter
refund information, choose or set a passphrase, unlock, migrate earlier
records, restore a backup, load the synthetic demo, or use capture. This is
the follow-up to B2 in [store/readiness.md](store/readiness.md). It is an
implementation milestone, **not** a legal certification, a compliance
declaration or a Chrome Web Store approval.

Policy text consulted on 2026-10-10:
[Chrome User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
(question 3: local-only handling must still be disclosed; question 10: a
prominent in-product disclosure, seen before agreeing, and a specific action
clearly agreeing to it before collecting or handling user data) and
[Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements/)
(prominent disclosure, affirmative consent, and prominent disclosure of
changed data practices).

## What the user sees

- **Dashboard, first open (fresh or updated installation):** an ordinary
  screen titled **How Refund Reconciler handles your data**, not a collapsed
  section, toast or preselected box. It lists, in short sections: purpose;
  what you type or import; optional capture from Amazon US pages; use and
  sharing; storage and retention; your choices. Then **Agree and continue**
  and **Not now**. It works at 360 px and desktop widths, in light and dark
  mode, by keyboard, with errors announced (`role="alert"` and a live region).
  Nothing is forced: no scroll-to-the-end requirement.
- **Not now** shows *Data features are unavailable* with **Review data
  practices**. Nothing is written or deleted; existing records stay exactly as
  stored. Reloading shows the disclosure again.
- **Agree and continue** stores a small receipt (below) and re-reads the state.
  A fresh installation then shows **Protect your records** (passphrase setup);
  an existing installation shows its existing state (unlock, migration of
  earlier plaintext records, or recovery). It never jumps straight to an empty
  dashboard. If storing the agreement fails, the screen says so and stays.
- **Data and privacy** in the dashboard header shows the same text at any time
  (before or after agreeing, locked or not). It has no agreement button.
  Opening it reads and writes nothing, does not close forms or clear drafts,
  and does not change the agreement.
- **Toolbar popup** before agreement: "Before Refund Reconciler can be used,
  please read how it handles your data and agree in the dashboard. Capture
  stays off until then." with **Open dashboard to review**. It never asks for
  agreement itself.

None of these count as agreement: installing, opening the dashboard or popup,
Not now, dismissing a notice, the guide or Data and privacy, help links,
selecting an item, ticking the capture item-applicability box, or ticking the
passphrase-recovery acknowledgment. The passphrase-recovery acknowledgment on
**Protect your records** remains a separate step, as does the per-capture
preview, item assignment and **Save merchant report**. Agreeing does not
capture or save any report.

## One shared definition, versioned

`src/consent/practices.ts` holds `DATA_PRACTICES_VERSION` (currently **1**)
and the displayed text. The dashboard renders that text and sends that version
when the user agrees; the service worker requires the same constant. The
version is independent of the extension version: ordinary fixes, updates that
keep the practices, browser restarts and worker restarts do not ask again. A
future change to the data practices (a new data type, a new use, data leaving
the browser) must change the text **and** bump the version, so every
installation is asked again before the changed practice runs.

## The receipt (consent format 1)

Stored in `chrome.storage.local` under `refundReconciler.consent`, separately
from the ledger:

```json
{ "format": "refund-reconciler-consent", "formatVersion": 1, "dataPracticesVersion": 1, "acceptedAt": "2026-10-10T12:00:00.000Z" }
```

- Exactly these four fields (`src/consent/receipt.ts` `parseConsent`).
  `acceptedAt` is written by the service worker when it stores the agreement,
  never taken from the page.
- Nothing private: no ledger data, passphrase, key, user or device
  identifier, selected text or address.
- Missing → `missing`. Present but not exactly valid → `invalid`. A valid
  receipt for another data-practices version → `obsolete`. Only a valid
  receipt for the current version is agreement. A storage read failure is a
  `storage_error`, never a first-use prompt and never agreement.
- It is not part of the ledger: no ledger revision, `lastRestore`, calculation,
  JSON backup or summary includes or changes it. Restore and migration neither
  import, create nor imply it. Ledger schema 1, backup format 1 and vault
  format 1 are unchanged.

## Enforcement in the service worker

Every request still runs through the worker's single queue after its
trusted-context storage restriction (`setAccessLevel`). Then
(`src/background/handler.ts`):

- **Gated** (`read`, `readLegacy`, `setup`, `migrate`, `unlock`, `mutate` —
  including the synthetic demo — and `restore`): the worker first reads **only**
  the receipt key. Without a current agreement it answers before any key
  derivation, decryption, ledger read, legacy parse or write:
  - `read` → `{ status: 'consent_required', reason, version }`;
  - every other gated request → error `consent_required` (or `storage_error`
    if the receipt could not be read). Nothing is changed.
  This holds even if the vault is still unlocked in the session (for example a
  0.7.0 session, or a receipt removed while unlocked): no records are returned.
- **Allowed without agreement:** `acceptDataPractices`, **Lock** and the typed
  **Erase stored data…** (`eraseAll`). The static explanation needs no request.
- **`acceptDataPractices { version }`**: a malformed request is
  `invalid_message`; a version other than the displayed one is
  `version_mismatch`; if the receipt cannot be read, `storage_error` and
  nothing is written; an already current agreement is `already_accepted`
  (idempotent, no write); otherwise the worker writes a new receipt (replacing
  only an obsolete or damaged one, never touching the vault or a legacy
  ledger), broadcasts a data-free change signal and answers `accepted`. A
  rejected write is `write_rejected` (not stored).

Pages never read the receipt themselves. They learn the state only from
validated `read` replies (`parseLedgerState` rejects a consent state for a
version the page does not display) and validated acceptance replies
(`isConsentResponse`). A lost acceptance reply is `outcome_unknown` on the
page, which re-reads the state: if the agreement is now current it continues;
otherwise it says the agreement "could not be confirmed and is not recorded
now".

## Views stay consistent

The consent receipt is one of the keys the dashboard and popup watch
(`chrome.storage.local.onChanged`, data-free), alongside the worker's
broadcast. When another view (or damage) removes, corrupts or makes the
agreement obsolete, every open dashboard drops private state (records, forms,
drafts, search, export and restore panels, prepared backups) and shows the
disclosure; the popup discards any preview. Earlier replies cannot bring the
data back: the dashboard applies only its newest read, the popup applies a
read only if it was sent after the last change signal, and exports, copies,
restores, plaintext migration backups, capture checks and save-outcome checks
each re-check their operation and privacy epoch before using a reply. An
agreement whose reply arrives after an erase or another newer state does not
show the next screen, because the dashboard advances only from a fresh read.
A write the worker already committed before the change is not undone, and a
download or clipboard copy already started cannot be recalled; the existing
messages say so.

## Erase, Lock and recovery

- **Erase stored data…** (typed `ERASE`) is available on the disclosure screen
  and on *Data features are unavailable*, as well as on the locked, migration
  and unreadable screens. It works without agreeing — for a forgotten
  passphrase, damaged or unsupported records, or simply to remove everything —
  and never reads record contents or counts. In one removal it deletes the
  vault, any earlier plaintext ledger, the migration marker **and the consent
  receipt**, then writes the usual fresh erase marker. A new start therefore
  shows the disclosure again. A rejected removal leaves everything, receipt
  included, in place and is reported. Earlier restore approvals still cannot
  apply (new vault identity and erase marker).
- **Lock** does not revoke the agreement.
- Nothing is erased automatically, and existing records are never shown as an
  empty ledger while agreement is pending.

## When page access starts

Before agreement, the popup performs **no** `tabs.query`, `tabs.get`, selection
read or script injection, even if the vault is still unlocked. Only after
agreement **and** unlock does opening the popup look up the active tab's
address (kept in memory) to check whether the page is supported. Pressing
**Capture** then reads the highlighted text (up to 4,000 characters) and the
page address on supported Amazon US pages. Saving still requires the preview,
an item, the item-applicability confirmation and **Save merchant report**.
See [capture.md](capture.md).

## Order of first-use screens

- Fresh installation: disclosure → Agree and continue → Protect your records →
  dashboard.
- Updated 0.7.0 installation: disclosure → Agree and continue → locked (the
  existing passphrase unlocks the same vault, unchanged).
- Updated 0.5.0/0.6.0 installation: disclosure → Agree and continue → Protect
  your existing records (migration, with the optional plaintext backup).
- After an erase: disclosure → Agree and continue → Protect your records.

## Tests

- Unit (`tests/unit/consent.test.ts`, real WebCrypto, storage fakes): strict
  receipt and message validation, current vs obsolete versions, fail-closed
  storage errors, idempotent acceptance, rejected writes, lost replies resolved
  by re-reading after a worker restart, refusal of every direct data request
  with records unchanged and no WebCrypto call, Lock and erase without
  agreement, erase removing the receipt atomically, and no revival of earlier
  restore approvals.
- Browser (`tests/e2e/consent.spec.ts`, production worker and UI, synthetic
  data): fresh dashboard and popup, Not now/reload/reading, failed agreement,
  agreement before setup; persistence across reopen, worker stop and browser
  restart; rereading with drafts open; 0.7.0-style encrypted and earlier
  plaintext records kept while gated; removal, damage and obsolescence on open
  views; held replies (read, export, copy, capture check, plaintext backup,
  agreement overtaken by erase); capture after agreement; typed erase while
  gated; keyboard, layout, light/dark and no external requests.
- Same-installation updates from 0.5.0, 0.6.0 and 0.7.0 built from source
  (`tests/update/`), and the extracted-ZIP smoke test.

## Not covered

No publisher identity, hosted policy URL, support contact or effective date
is invented or linked: those remain publisher inputs. Whether Google's
reviewers consider this flow sufficient is not known. Real Amazon wording and
a real toolbar click on 0.8.0 have not been checked (see
[validation.md](validation.md)).
