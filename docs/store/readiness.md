# Chrome Web Store readiness assessment (draft)

- **Audit date:** 2026-10-10
- **Audited source:** `main` at `a7e5df9` (merge of PR #7; reviewed head
  `60e330b`), extension version **0.6.0**. This assessment changes no
  runtime code, manifest, permission, asset or schema.
- **Verdict:** **not ready to submit.** Two privacy/security questions are
  unresolved (see [B1](#b1-encryption-at-rest-unresolved-policy-question) and
  [B2](#b2-prominent-disclosure-and-affirmative-consent-gap)), publisher
  information and a hosted policy URL are missing, and store images do not
  exist yet. This document does not say that Google has rejected anything.
  It is not a compliance declaration or legal advice.
- **Update for Task 09 (version 0.7.0, 2026-10-10):** B1's recommended
  protection is **implemented** (see [Task 09 status](#task-09-status-070)).
  The verdict stays **not ready to submit**: B2 (in-product disclosure and
  consent), publisher inputs, a hosted policy, store images, a new
  owner-operated toolbar check of the changed popup, and the store review
  itself are all still pending. The sections below are the Task 08 audit of
  0.6.0 unless they say otherwise.

## Task 09 status (0.7.0)

Facts (code and tests on the Task 09 branch; details in
[../vault.md](../vault.md)):

- The ledger is stored only as an AES-256-GCM ciphertext under
  `refundReconciler.vault`. A random data key is wrapped under a key derived
  from the user's passphrase with PBKDF2-HMAC-SHA-256 (600,000 iterations,
  16-byte salt). No note, reference, excerpt, amount, case list or receipt
  is plaintext metadata. Pages never read storage; the service worker reads,
  decrypts, validates and writes (`src/background/handler.ts`,
  `src/vault/`).
- **Protect your records** comes before any ledger can exist. It explains
  local storage, when the passphrase is needed, that there is no recovery
  service, that exports are plaintext, and what is not protected, and it
  requires an acknowledgment of the recovery limit. **This is not the B2
  consent step**: it does not disclose capture's data types or ask for
  agreement to data handling.
- **Lock now**, locked-state unlock and typed erase, and a verified,
  fault-tolerant migration of 0.5.0/0.6.0 plaintext ledgers exist. While
  locked or before setup, the popup reads no tab address or selection (F4 and
  F5 now happen only while unlocked).
- Evidence: unit tests with real WebCrypto (tampering, bounds, unique IVs,
  every migration storage fault, restarts, races), browser tests
  (`tests/e2e/vault.spec.ts`: a canary typed through the UI is absent from
  `chrome.storage.local` and from the closed profile's extension-storage
  files; the data key is absent from the whole profile on disk; multi-view
  Lock; worker stop and browser restart; migration), and update checks from
  0.5.0 and 0.6.0 built from source.
- Plaintext that 0.5.0/0.6.0 wrote may remain in Chrome's database and log
  files after migration; earlier exports stay readable. Neither is claimed
  to be removed.

Interpretation: on the conservative reading of FAQ Q9, the stored financial
records are now "stored at rest using a strong encryption method such as
… AES". Whether Google's reviewers accept a passphrase-based local design,
and whether they would have required it at all, is **not known**; this is
not a compliance certification.

Still pending: B2 (a one-time disclose-and-agree step before the first
capture or case, re-shown on data-practice changes); publisher name,
contact, hosted policy URL and effective date; store icon padding,
promotional tile and screenshots; dashboard-label confirmation of every
privacy answer (including whether the passphrase counts as
"authentication information"); a new owner-operated toolbar check for
0.7.0; and the store review.

Related drafts: [listing.md](listing.md),
[privacy-policy.md](privacy-policy.md) /
[privacy-policy.html](privacy-policy.html) (a readable standalone copy) and
[privacy-practices.md](privacy-practices.md). Validation status:
[../validation.md](../validation.md).

How to read the labels used below:

- **Fact:** confirmed by reading the code or the production build (`dist/`), with file and function references.
- **Interpretation:** a reading of policy text, which Google may read differently.
- **Pending:** information only the publisher can supply.
- **Untested:** behaviour nobody has checked.

## Sources consulted

All six pages were fetched on 2026-10-10 (HTTP 200). Each page's
"Last updated" footer is shown.

| Page | Footer date | Sections used |
| --- | --- | --- |
| [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) | 2016-04-23 | Q2 "handle", Q3 local processing, Q4 examples of user data, Q6, Q7, Q8 and Q9 encryption, Q10 prominent disclosure, Q14 local-only privacy policy; *Minimum Permission* Q3 and Q4; *Limited uses* Q1–Q3 and Q7; *Simplifying privacy practices* Q1 and Q3 |
| [Handling Requirements](https://developer.chrome.com/docs/webstore/program-policies/data-handling) | 2022-11-01 | Whole page (four sentences) |
| [Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements/) | 2022-11-01 | Whole page |
| [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) | 2022-11-01 | Necessary-for-single-purpose rule, web-browsing-activity rule, transfer and human-reading limits, affirmative statement |
| [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) | 2020-06-12 | Single purpose, permission justification, remote code, data usage certification, privacy policy |
| [Supplying images](https://developer.chrome.com/docs/webstore/images) | 2018-06-11 | Extension icon, Icon size, Promotional images, Screenshots |

Limits on what was inspected:

- **FAQ footer date:** the FAQ says it was last updated on 2016-04-23, yet
  it mentions enforcement from 10/15/2019 and warnings from March 2021. Its
  footer date therefore does not show when its answers were last changed.
- **Dashboard checkbox wording:** the exact labels and on-screen definitions
  of the dashboard's data-type and certification checkboxes are visible only
  inside the Developer Dashboard. No developer account was registered, so
  they were **not inspected**. [privacy-practices.md](privacy-practices.md)
  maps the data to the FAQ's Q4 categories, and every checkbox label must be
  confirmed in the dashboard before anyone answers.
- **Not consulted:** Chrome's permission-warning documentation and the
  general Program Policies hub. Claims that depend on them are marked
  untested.

## Data flows in the production build (facts)

All flows below were traced in `src/` and checked against `dist/` after
`vite build`. The build contains no `fetch`, `XMLHttpRequest`,
`WebSocket`, `sendBeacon`, `eval`, `new Function`, `importScripts` or
dynamic `import(`. Its only URL literals are `https://amazon.com` and
`https://www.amazon.com`, which are used for comparison in
`src/capture/source.ts`, `SUPPORTED_ORIGINS`. Test helpers (`tests/`),
build tools (`scripts/`, `vite.config.ts`) and the test-only permissions
described in [capture.md](../capture.md) never reach `dist/` or the ZIP
(`scripts/package-beta.ts` packages `dist/` only).

| # | Flow | Data | When acquired | Held where | Persisted? | Leaves the device? | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Manual case entry | Optional order reference (≤100 chars), item descriptions (≤200), expected amounts or "Unknown" | User types and submits **Create case** | Dashboard memory, then the service worker | Yes, in `chrome.storage.local` key `refundReconciler.store` | No | `src/ui/app.ts` create form (`order-ref`, `item-label-*`, `item-amount-*`); `src/domain/ledger.ts` `applyCommand`; `src/persistence/storage.ts` `saveStore`; limits in `src/domain/validate.ts` `LIMITS` |
| F2 | Manual evidence entries | Kind (expected amount, merchant report, receipt, recharge), amount, optional date, optional transaction/observation reference (≤100), source text (≤100, defaults to "Manual entry"), optional note (≤1000) | User submits the entry form | As F1 | Yes | No | `src/ui/app.ts` entry form (`entry-*` fields, `DEFAULT_SOURCE`); `src/domain/types.ts` `MerchantReportEntry`, `ReceiptEntry`, `RechargeEntry` |
| F3 | Void | Target entry ID and reason (≤500, stored as `note`) | User confirms **Void** | As F1 | Yes; the original entry is kept | No | `src/ui/app.ts` `void-reason`; `src/domain/ledger.ts` (void builds `note: cmd.reason`) |
| F4 | Toolbar click: tab address | URL of the active tab, which is visible only because the click grants `activeTab` | **When the popup opens**, before Capture is clicked | Popup memory: the URL is reduced to a supported origin or `null` | No | No | `src/popup/main.ts` `sourceTab()` (`chrome.tabs.query`); `src/popup/popup.ts` `startPopup` → `checkSourceUrl` |
| F5 | Capture: selection | Selected text (≤4,000 chars; longer selections are not returned) and the document's `location.href` | User clicks **Capture selected refund text** | Popup memory (`Preview`) | No, not until F6 | No | `src/capture/acquire.ts` `acquireSelection` / `chromeAcquireDeps` (`chrome.scripting.executeScript`, main frame, isolated world); `src/capture/collector.ts` `collectSelection` (refuses editable fields; reads nothing else) |
| F6 | Capture approval | Normalised excerpt, origin, sanitised path (tracking segments, fragment and every query parameter except one valid `orderID` dropped), capture time, parser version, approved amount text, detected order number, merchant-report amount and date | User selects a case and item, ticks the item-applicability box, then **Save merchant report** | Service worker | Yes, inside the merchant-report entry (`capture`) | No | `src/popup/popup.ts` `approve`, `save`; `src/capture/source.ts` `analyzeSourceUrl`; `src/domain/types.ts` `CaptureProvenance` |
| F7a | Discard/close **before Save** | The unsubmitted F5 preview | User chooses **Discard**/**Cancel** or closes the popup before pressing **Save merchant report** | — | Nothing is written. The notice reads "Capture discarded. Nothing was saved." | No | `src/popup/popup.ts` `cancel` (`op === null` branch; in-memory phase reset); e2e "finding 4: stopping an uncertain save makes no claim; an unsubmitted cancel and unreadable cases stay accurate" in `tests/e2e/capture-hardening.spec.ts` |
| F7b | Close or **Stop waiting** **after Save** | The approved F6 report, already sent to the service worker | User presses **Save merchant report**, then the reply is lost or delayed and the user chooses **Stop waiting** or closes the popup | Service worker | **Possibly yes.** Closing or stopping does not cancel the request, and the worker may already have committed it. The popup says the report "may already have been saved" and points the user to the dashboard. A retry reuses the same operation ID, so the report cannot be recorded twice | No | `src/popup/popup.ts` `save` (`outcome_unknown` → `uncertain`), `cancel` (`op !== null` branch), `renderSubmitted`; same e2e test (one stored merchant report after a lost reply and **Stop waiting**) |
| F8 | Synthetic demo | Built-in fake cases (`isDemo: true`) | User clicks **Load synthetic demo** | Storage | Yes, until **Remove synthetic demo** | No | `src/domain/demo.ts` `buildDemoCases`; `src/domain/ledger.ts` `loadDemo`/`removeDemo` |
| F9 | Case summary | Plain text of one case. Order reference, item descriptions, amounts, dates, sources, capture origin and path, and detected order number are always included. Notes, references and excerpts appear only when the user opts in | User opens **Prepare case summary…**, then **Copy** or **Download** | Dashboard memory; clipboard via `navigator.clipboard.writeText`; file via a blob download | Outside the extension: on the clipboard or in a user-saved file | Only if the user shares it | `src/export/summary.ts` `buildCaseSummaryText` (`includeDetails`); `src/ui/app.ts` `copyExport`, `downloadExport`; `src/ui/deps.ts` `dashboardDeps`, `requestBlobDownload` |
| F10 | JSON backup | The entire validated store: every case (demo cases included), entry, void and capture excerpt, plus `lastRestore` and `ledgerEpoch` | User clicks **Download all data (JSON)…**, then Download or Copy | As F9 | A plain-text, unencrypted user file | Only if the user shares it | `src/export/backup.ts` `buildBackup`, `serializeBackup`, `exportFilename` (the filename uses no stored text) |
| F11 | Restore | A user-chosen backup file (≤25 MiB) | User picks the file (it is read into memory) and clicks **Restore** (it is written) | Dashboard memory, then the service worker | Yes, and only into a ledger with no cases | No | `src/ui/restore.ts` `chooseFile`; `src/background/handler.ts` restore branch; `src/domain/restore.ts` `decideRestore` |
| F12 | Delete/erase | — | **Delete case…** → **Permanently delete** (one case). **Erase stored data…** appears **only when stored data is unreadable**; it leaves an empty ledger and a random `ledgerEpoch` | Storage | Removes records from the stored value | No | `src/domain/ledger.ts` `deleteCase`; `src/ui/app.ts` `renderUnreadable`, `eraseAll`; `src/persistence/storage.ts` `eraseStore` |
| F13 | Diagnostics | A single `console.error` call, used only if `setAccessLevel` fails, which logs the error object (no ledger data). The unreadable-data screen shows the raw stored value in a read-only textarea, on the device | Automatic / when data is unreadable | DevTools console / dashboard | No | No | `src/background/service-worker.ts`; `src/ui/app.ts` `renderUnreadable` |
| F14 | Page context isolation | Page scripts and the injected collector cannot read the ledger | Service-worker start | — | — | — | `src/background/service-worker.ts` `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`; sender check in `onMessage` |

F14 is an access-control setting. **It is not encryption**: in 0.6.0 the
stored value is ordinary JSON in the profile's extension storage (Fact, for
0.6.0: `src/persistence/storage.ts` `saveStore` wrote the `StoreData` object
as is). In 0.7.0 F1–F3, F6, F8 and F11 are written only as vault ciphertext,
F14 covers `chrome.storage.session` too, and F12's erase is typed and also
available while locked ([Task 09 status](#task-09-status-070)).

## Requirement matrix

Status values: **Met** (fact), **Gap** (fact, with work needed),
**Unresolved** (policy interpretation still open), **Pending**
(publisher), **Untested**.

| # | Requirement (source) | Current behaviour | Evidence | Status | Follow-up |
| --- | --- | --- | --- | --- | --- |
| R1 | Locally stored or processed data must still be disclosed (FAQ Q3, Q14) | The extension handles user data (F1–F11): typed financial evidence, page excerpts and page addresses. Nothing is transmitted | Data-flow table above | **Gap** (no store policy yet) | Host the [draft policy](privacy-policy.md) after publisher fields are filled in |
| R2 | Post a privacy policy in the dashboard (FAQ Q6, Q14; dashboard page "Set a privacy policy") | A draft exists; nothing is hosted | [privacy-policy.md](privacy-policy.md) | **Pending** | Publisher hosts it on a URL they control and enters that URL |
| R3 | Handle user data securely; encrypt transmissions (Handling Requirements; FAQ Q8) | No transmissions exist | Build scan above | **Met** for transmission | Re-assess if any network feature is ever added |
| R4 | At-rest encryption (FAQ Q9) | 0.6.0: stored ledger and exports unencrypted. **0.7.0: stored ledger encrypted (passphrase-wrapped AES-256-GCM key); exports remain plaintext by design** | 0.7.0: `src/vault/crypto.ts`, `src/background/handler.ts`, [vault.md](../vault.md); `src/export/backup.ts` `serializeBackup` | **Implemented in 0.7.0** (fact); policy acceptance **unknown** (interpretation) | See [Task 09 status](#task-09-status-070) |
| R5 | Prominent disclosure plus affirmative consent "prior to installation" (Disclosure Requirements), within the product UI and before collecting or handling (FAQ Q10) | Dashboard and popup headers give partial notice. Capture requires explicit clicks, and saving requires a preview and **Save**. There is no disclosure-and-agree step | `dashboard.html`, `popup.html` headers; `src/popup/popup.ts` `renderBody`; `src/ui/help.ts` | **Gap** | See [B2](#b2-prominent-disclosure-and-affirmative-consent-gap) |
| R6 | Single, narrow purpose (dashboard page "State the extension's purpose") | Per-item refund-evidence tracking. Capture, exports, restore and the overview all serve it | `README.md` scope; feature code | **Met** (interpretation) | Use the wording in [privacy-practices.md](privacy-practices.md) |
| R7 | Minimum permissions (FAQ *Minimum Permission* Q3; dashboard page "List and justify") | `storage`, `activeTab`, `scripting`. No host permissions, `tabs`, content scripts, `downloads` or `clipboardWrite` | `public/manifest.json`; see [Permissions](#permissions) | **Met** | List the permissions on an about page (FAQ *Minimum Permission* Q4). README and beta.md already do |
| R8 | No remote code (dashboard page "Declare any remote code") | All code is bundled. CSP `script-src 'self'`. The injected function is bundled `func` | `public/manifest.json` CSP; `src/capture/acquire.ts`; build scan | **Met** | Answer "No" |
| R9 | Limited Use: use data only for the single purpose; transfer, advertising, creditworthiness and human-reading limits | No transfer, advertising or developer access. Data stays on the device | Build scan; data-flow table | **Met** (fact plus interpretation) | Certify only after B1 and B2 are settled |
| R10 | Web browsing activity only for a user-facing feature described prominently on the store page **and** in the UI (Limited Use) | The page address is used for capture provenance and order matching, after a toolbar click and Capture | F4–F6 | **Met in the UI; Pending on the store page** | The listing must describe capture and its stored page address ([listing.md](listing.md) does) |
| R11 | Limited Use affirmative statement on a website belonging to the extension (Limited Use; FAQ *Limited uses* Q1) | None hosted | — | **Pending** | Included in the draft policy; needs hosting |
| R12 | Privacy policy, dashboard answers and behaviour must be consistent (FAQ *Simplifying* Q3) | The drafts were checked against the code (see [Consistency](#consistency-check)). Stale in-product help copy remains | `src/ui/help.ts` | **Gap** (copy) | See [Stale copy](#stale-in-product-copy) |
| R13 | Don't publicly disclose financial or payment information (Handling Requirements; FAQ Q11) | The extension publishes nothing. Users can export and share files themselves | F9, F10 | **Met** | Keep the warnings about plaintext exports |
| R14 | 128×128 PNG icon with 96×96 artwork and 16 px transparent padding (Images: Extension icon, Icon size) | 128×128 PNG. Opaque artwork spans x/y 4–123 (120×120 with a 4 px margin) | `assets-src/icon.svg` (`rect x=4 width=120`); measured from `public/icons/icon-128.png` | **Gap** | A padded store icon (an asset change, done later) |
| R15 | Small promo tile 440×280 (required); screenshots 1280×800 or 640×400, at least 1 (Images) | None exist | — | **Gap** | See [Assets](#remaining-asset-work) |
| R16 | Publisher identity, contact, policy URL, effective date | Not supplied | — | **Pending** | See [Publisher inputs](#publisher-inputs-pending) |

## B1. Encryption at rest (unresolved policy question)

> **Task 09 status:** the owner chose option 1 below; 0.7.0 implements it
> ([Task 09 status](#task-09-status-070)). The policy question itself (how
> reviewers read FAQ Q9 for local-only data) is still not answered by Google,
> and no support contact was made.

The pages differ on encryption at rest:

- Handling Requirements (updated 2022-11-01): *"it must handle the user data
  securely, including transmitting it via modern cryptography."* This page
  never mentions storage.
- FAQ Q8: *"This policy establishes a minimum requirement of encrypting
  transmissions of all user data"*.
- FAQ Q9: *"Extensions must transmit user data over a secure connection
  (e.g. HTTPS, WSS) and stored at rest using a strong encryption method such
  as RSA or AES."*

So the binding policy page and FAQ Q8 set transmission as the minimum, while
FAQ Q9 says stored data "must" be encrypted at rest. The FAQ also says
(Q3, Q14) that local-only handling is still subject to disclosure and a
privacy policy. Nothing on these pages exempts locally stored data from Q9.

How this applies here (fact): the extension stores financial and payment
evidence in plain JSON in `chrome.storage.local`: refund amounts,
confirmed receipts, recharges and transaction references (F1–F3, F6). It
also stores page excerpts (F6). F14 (`TRUSTED_CONTEXTS`) controls which
extension contexts can call the API. It does not protect the files in the
profile.

Assessment (interpretation): a reviewer reading FAQ Q9 literally could
treat unencrypted stored financial data as non-compliant. Stating in a
disclosure that data is "not encrypted" makes the extension honest about it,
but **does not satisfy** an encryption requirement. Local storage is **not**
automatically exempt.

Status: **unresolved**. How to resolve it, from cheapest to most certain:

1. **Owner decision (recommended):** treat FAQ Q9 as applicable and add
   real at-rest protection before submitting (see the
   [next step](#recommended-next-implementation-step)). Its threat model is
   worth having anyway for financial records on a shared or lost computer.
2. Alternatively, the owner may ask Chrome Web Store developer support,
   through the publisher's own channel, whether FAQ Q9 applies to data that
   is stored only locally and never transmitted. This task did not contact
   Google. Any answer should be kept in writing alongside this file.

## B2. Prominent disclosure and affirmative consent (gap)

What the policy text says:

- Disclosure Requirements: *"prior to installation, it must: Prominently
  disclose what user data will be collected and how it will be used. Obtain
  the user's affirmative and informed consent for such use."*
- FAQ Q10: the disclosure must be shown so *"the user sees it prior to
  agreeing"*, and consent must require *"a specific action clearly agreeing
  to the disclosure before collecting or handling user data"*. It *"must
  occur within the Product's user interface. Disclosures in the Chrome Web
  Store description or inline installation page do not satisfy this
  requirement."*

These pages differ too: one says "prior to installation", the other says
"within the Product's user interface". An in-product step cannot happen
before installation. Interpretation: the listing and privacy policy cover
the pre-install disclosure, and an in-product disclose-and-agree step is
still needed before the first collection. Whether Google expects both cannot
be settled from these pages alone. The conservative reading is to do both.

What happens today (facts):

| Moment | Notice shown | User action | Gap |
| --- | --- | --- | --- |
| Install | Store page (not yet written); Chrome's install dialog | Install | Whether these three permissions show any install warning was **not verified** in this audit (**untested**) |
| Opening the dashboard | Header: "…Data stays in this browser profile (chrome.storage.local, not encrypted). This tool tracks evidence; it does not move money…" (`dashboard.html`) | None | Notice, but no agree step. The full explanation is inside the collapsed **How to use** guide (`src/ui/help.ts`), which is not prominent |
| Manual entry (F1–F3) | Field labels | User types and submits | Users knowingly provide data, but nothing explicitly agrees to local storage of financial records |
| Toolbar click (F4) | Popup header: "Local only; nothing is sent anywhere." | Toolbar click | **The tab URL is read when the popup opens**, before Capture. It is kept only in memory and is not stored. The help text says the address is read "only after you click the toolbar button and choose Capture", which is imprecise |
| Capture (F5) | "To capture a refund record: … highlight the refund line for one item, then choose Capture. You will see a preview; nothing is saved until you approve it." (`src/popup/popup.ts` `renderBody`) | Click **Capture** | The specific action comes **before** the read. The notice does not say that the selected text and page address are read, or that an approved capture is stored unencrypted until deleted. There is no one-time consent |
| Save (F6) | Preview showing exactly what will be stored ("Selected text", "Source", amount, order, date) | Choose case and item, tick "this amount is the refund for this one item", then **Save merchant report** | Strong approval of each record, but the checkbox confirms item applicability, **not** consent to storage. Retention and encryption are not mentioned |

Required follow-up (later task, not this one): a one-time, in-product
disclosure screen that (a) names the data types (typed financial evidence,
selected page text, page address), (b) says where they are stored, whether
they are protected and how long they are kept, and (c) requires an explicit
**Agree** before the first case can be created or the first capture can run.
It should be reachable again from the dashboard, be re-shown when data
practices change (Disclosure Requirements: "must prominently disclose data
practice changes"), and leave the existing per-capture preview and Save
unchanged. A collapsed help section or the listing alone does not meet FAQ
Q10.

## Permissions

| Permission | Why it is needed (facts) | Narrower alternative? |
| --- | --- | --- |
| `storage` | `chrome.storage.local` holds the ledger (`src/persistence/storage.ts` `chromeLocalArea`, `STORE_KEY`). `chrome.storage.onChanged` keeps open views current (`src/ui/deps.ts` `subscribe`). `setAccessLevel` restricts access (`src/background/service-worker.ts`) | None. `sync` is not used |
| `activeTab` | After a toolbar click, it lets the popup see the active tab's URL (`src/popup/main.ts` `sourceTab`, `chrome.tabs.query`) and lets `chrome.tabs.get` and script injection target that tab without host permissions (`src/capture/acquire.ts`). Access is temporary and limited to that tab | Host permission for `*://*.amazon.com/*` would be broader: persistent access with no click required. `tabs` would expose every tab's URL. Neither is used |
| `scripting` | `chrome.scripting.executeScript` runs the one bundled function `collectSelection` in the main frame's isolated world after **Capture** (`src/capture/acquire.ts` `chromeAcquireDeps`) | Declared content scripts would run on every matching page load. `activeTab` alone does not inject code |

Clipboard copy uses `navigator.clipboard.writeText` on a user click, and
downloads use a blob link (`src/ui/deps.ts`). Neither needs a permission.

## Single purpose, remote code, limited use

- **Single purpose (interpretation, Met):** "Track, item by item, the refund
  evidence a user records for Amazon US returns, and show what is still
  unresolved." Selected-text capture is an optional input method for the
  same records, and exports, restore and the overview all operate on them.
- **Remote code (fact, Met):** none. The CSP is
  `script-src 'self'; object-src 'none'; base-uri 'none'`, and the build
  scan is above.
- **Limited use (fact, Met):** the developer receives nothing, so there is
  no transfer, sale, advertising, creditworthiness use or human reading by
  the developer. Users may share their own exports, which is their choice
  and outside the extension. Any future network, sync, analytics, support
  upload or AI feature would change these answers. It would need a fresh
  disclosure, consent and dashboard update **before** release.

## Consistency check

The drafts were checked against the code (facts in the data-flow table):

- Every statement that data is stored, unencrypted or never transmitted
  matches F1–F14. No draft says "no data is handled".
- The policy and dashboard drafts describe the F4 tab-address read at
  popup open. The current in-product help does not (see below).
- Deletion is described exactly as built: delete one case at a time,
  remove the demo, erase only when data is unreadable, and uninstall
  removes everything. The drafts do not promise an "erase all" button for
  readable data, because none exists.
- Exports are described as plaintext files that the extension cannot track
  or delete (README; `src/ui/deps.ts`).
- The proposed future protections (B1, B2) appear only in this file and in
  clearly separated "not in this version" notes, never as current policy
  text.

## Stale in-product copy

**Resolved in 0.7.0:** `src/ui/help.ts` now uses the proposed parser wording
and describes the address read exactly as gated in 0.7.0 (only while the
records are unlocked; nothing is read while locked). The Task 08 finding is
kept below for the record.

`src/ui/help.ts`, under "About capturing selected text", said in 0.6.0:

> Capture is a preview feature. It has been tested only with synthetic
> example pages, not with live Amazon pages, so it may not recognise the
> wording you see.

This is now out of date: a real toolbar click on the public amazon.com page
has been owner-reported as working. The refund **parser**, however, is
still validated only on synthetic text. Proposed replacement:

> Capture is a preview feature. Its refund-wording rules have been tested
> only on synthetic examples, not on real Amazon refund pages, so it may not
> recognise the wording you see. Reading a selection from a public
> amazon.com page after a toolbar click has been checked.

The next bullet in the same section, "Only the text you highlight and the
page address are read, and only after you click the toolbar button and
choose Capture", should become:

> When you click the toolbar button, Chrome lets the extension see the
> current tab's address so it can check whether the page is supported; it
> is not saved. Only after you choose Capture is the highlighted text read.
> Nothing is saved until you approve the preview.

`tests/e2e/help.spec.ts` asserts the current wording ("tested only with
synthetic example pages"), so the same future task must update that
assertion. Runtime copy is unchanged in this documentation PR.

## Runtime observations (no defects found)

- No runtime defect was found during this audit.
- The tab-URL read at popup open (F4) is by design (`src/popup/popup.ts`
  `startPopup`, `sourceReady`). It is a disclosure-precision issue, not a
  data leak: only an origin or `null` is kept, in memory.
- For readable data, there is no single "erase all" control (F12). Users
  delete cases one by one or uninstall. This is a usability and privacy
  improvement for later, not a defect.
- Deleting removes records from the stored value. The extension cannot
  guarantee that Chrome's underlying database files no longer contain old
  bytes on disk (this has not been investigated). The drafts make no
  secure-deletion claim.
- **Untested:** behaviour when a user allows the extension in Incognito.
  The manifest has no `incognito` key, so Chrome's default applies. Whether
  incognito captures share the regular profile's storage has not been
  checked, and the drafts make no claim about it.

## Remaining asset work

Assets should be produced **after** any product changes, from the eventual
production build, using synthetic data. None are manufactured here.

| Asset | Requirement (Images page) | Current | Work |
| --- | --- | --- | --- |
| Extension icon in the ZIP | 128×128 PNG; square artwork about 96×96 with 16 px transparent padding per side; works on light and dark | `public/icons/icon-128.png`, generated from `assets-src/icon.svg`. A 120×120 rounded tile with a 4 px margin | Add a padded 128 variant (scale the tile to about 96×96 within the 128 canvas) and regenerate with `npm run icons`. The 16/32/48 toolbar sizes can keep tighter margins. Re-check that it reads well on dark backgrounds |
| Small promo tile | 440×280, required; avoid text; fill the region | None | Brand-led artwork based on the icon. No UI text, badges or claims |
| Marquee | 1400×560, optional | None | Optional; skip at first |
| Screenshots | At least 1 (up to 5), 1280×800 (preferred) or 640×400, full bleed; must show the actual experience | None | See the outline below |

Three truthful screenshot outlines (production build, synthetic data that
is clearly labelled, 1280×800):

1. **Case list and overview.** The dashboard after **Load synthetic demo**
   plus one made-up case entered manually (for example "Synthetic item D"),
   showing **Needs attention** and **Needs review** counts and the status
   filter. Caption: "See which returned items still have unresolved refund
   evidence."
2. **One case, item by item.** A synthetic case detail with an expected
   amount, a merchant report, a confirmed receipt, a recharge and a voided
   entry kept in history. Caption: "Merchant reports, confirmed receipts and
   recharges are kept separately."
3. **Case summary and backup.** **Prepare case summary…** with evidence
   details omitted, beside the **Your data** panel (Download all data /
   Restore). Caption: "Copy a plain-text summary or save a backup. Nothing
   is sent anywhere."

A capture screenshot is deliberately **not** proposed. The production build
captures only on amazon.com, and a truthful refund preview would need a real
order. Fixture pages run only in a test copy with extra permissions, so they
would not show the production experience. Any later capture image must come
from the production build and contain no real order data.

## Publisher inputs (pending)

- Publisher or developer name as it will appear in the store.
- A contact email or support URL that the publisher controls.
- A privacy policy URL hosted on a site the publisher controls; the same
  site carries the Limited Use statement.
- The privacy policy's effective date, set when it is published.
- Whether the store name stays as the manifest's current
  **"Refund Reconciler (local preview)"** (changing it is a manifest change).
- Approval of the B2 design. (B1 was decided by the owner for Task 09:
  implement encryption; done in 0.7.0.)
- Distribution choices (visibility, regions), category and language, which
  are dashboard settings.
- Store support details, if any. The drafts promise none.

## Untested behaviour

- Real Amazon refund wording through capture (Check 2 in
  [beta.md](../beta.md#manual-checks)).
- Updating through the `chrome://extensions` UI (Check 3).
- Toolbar access was **owner-reported** for **0.6.0**, not independently
  reproduced, and covers one Chrome version (154.0.8037.98). The 0.7.0 popup
  changed (unlock gating) and has **not** had an owner-operated toolbar
  check. See [validation.md](../validation.md).
- 0.7.0 KDF timing on users' real computers (only a cloud container was
  measured; see [vault.md](../vault.md#evidence)).
- Install-dialog permission warnings for this manifest.
- Incognito behaviour.
- Any Chrome Web Store review outcome.

## Recommended next implementation step

**After Task 09: B2, the in-product disclosure and consent step** (and the
toolbar re-check of the 0.7.0 popup), now that the storage behaviour it must
describe is final. The Task 08 recommendation below (Task 09, at-rest
protection) has been implemented.

**Task 08 recommendation (implemented in Task 09):** local at-rest
protection of the stored ledger (passphrase-wrapped data key). This resolves
B1 on the conservative reading. B2 (disclosure and consent, plus the
help-copy fix) should be the separate task after it, so that the disclosure
text can describe the final storage behaviour.

### Options compared (local only; no account, backend or AI)

| Option | Protects against | Does not protect against | Verdict |
| --- | --- | --- | --- |
| A. A random AES-GCM key generated by the extension and stored in the same profile (IndexedDB as a non-extractable `CryptoKey`, or in `storage.local`) | Casual inspection of a single storage file; arguably the literal wording of FAQ Q9 | **Anyone who can read the whole profile**, because the key sits beside the ciphertext | Not recommended: it would claim more protection than it gives |
| B. **A user passphrase run through PBKDF2-SHA-256 (WebCrypto) to derive a key that wraps a random AES-256-GCM data key.** The unlocked data key is kept only in memory or in `chrome.storage.session` | A copied or stolen profile, disk or profile backup, or another OS account reading files, **without the passphrase** | Malware or another person using the browser **while unlocked**; keyloggers; weak passphrases; plaintext exports; older plaintext left on disk from before migration | **Recommended** |
| C. A WebAuthn/passkey PRF-derived key | As B, with hardware backing | Inconsistent support across Chrome, OS and authenticator; more complex recovery | Not now; revisit later |

### Proposed design (Task 08; implemented in Task 09)

Implemented as described in [vault.md](../vault.md), with these
differences from the proposal: the additional authenticated data binds the
format, version, vault id and KDF/cipher parameters, while the schema version
and revision stay **inside** the ciphertext (they are not exposed as
plaintext metadata, and authenticating them would not prevent replay of an
older envelope anyway); erase removes the vault and leaves a separate
nonprivate erase marker whose epoch the next vault's ledger carries; the
erase confirmation is a typed `ERASE`; and migration writes a nonprivate
progress marker so a restart can tell a pending migration from a finished
one.

- **Storage format.** A new vault record holds the format version, KDF
  parameters (salt, iteration count recorded with the data), the wrapped
  data key, and for each write a fresh 96-bit random IV with AES-GCM
  ciphertext of the `StoreData` JSON. The schema version and revision go
  in the additional authenticated data. The plaintext `StoreData` schema 1
  stays the in-memory model, and every read still goes through `parseStore`.
- **Lock and unlock, service-worker suspension, restart.** The data key is
  held in service-worker memory and in `chrome.storage.session` (memory
  only, access level `TRUSTED_CONTEXTS`), so a suspended worker can resume
  without asking again. A browser restart, extension reload or update clears
  it, and the user unlocks again. **Lock now** clears it immediately. While
  locked, the dashboard shows only an unlock screen. The popup offers
  **Open dashboard to unlock**, and capture is not available while locked.
- **Wrong passphrase, corruption.** If the key cannot be unwrapped, the
  dashboard says "wrong passphrase or damaged key" (the two cannot be told
  apart) and allows retrying. It never resets. A wrong passphrase only
  costs PBKDF2 time. If data fails to decrypt with a correctly unwrapped
  key, the data is treated as unreadable: it is shown read-only, writes are
  blocked, and **Erase stored data…** is offered, as today. Nothing is
  repaired automatically.
- **Write failures.** All writes still go through the service worker's
  serialised queue: decrypt the latest data, apply the command, encrypt with
  a new IV, then make one `set()`. A rejected `set()` means nothing changed,
  which keeps today's semantics.
- **Erase.** Erasing works **while locked**, behind the existing typed
  confirmation, so a forgotten passphrase never leaves the user stuck. It
  writes an empty vault marker with a new `ledgerEpoch`. **A forgotten
  passphrase means the data is lost**, and the setup screen must say so.
- **Migration without losing history.** On first run of the new version,
  if a plaintext `refundReconciler.store` exists:
  1. Validate it with `parseStore`; if it is unreadable, do not migrate.
  2. Ask the user to set a passphrase, and offer a JSON backup first.
  3. Write the vault while the plaintext is still present.
  4. Read the vault back, decrypt it and compare deeply with the original,
     including `revision`, `lastRestore` and `ledgerEpoch`.
  5. Only then remove the plaintext key.

  Interrupted at any step, the next start resumes safely: plaintext only →
  restart migration; plaintext and a matching vault → finish the removal; a
  mismatch → stop, show both as read-only, and never pick one silently.
  Until migration finishes, writes are blocked.

  Migration protects the **current** ledger and every later write. It does
  **not** retroactively protect historical plaintext. Bytes written by 0.6.0
  can remain in Chrome's on-disk extension storage files after the plaintext
  key is removed. Review evidence (reported in the Task 08.1 review, not
  reproduced here): in a fresh temporary Windows profile, a synthetic note
  saved through the unchanged 0.6.0 dashboard was still present in the
  extension storage's `000003.log` after its ledger key had been removed
  through `chrome.storage.local` and the browser had been closed, although
  the API no longer returned it. Earlier plaintext JSON backups and
  summaries are also unaffected by migration. The product copy and the
  privacy policy must say both things, and must not claim secure wiping.
- **Legacy restore.** Plaintext backups in format version 1, including Task
  03–07 files, still restore into an empty, unlocked ledger. They are
  encrypted when written. Restore receipts and staleness checks keep
  working, with the digest computed over the decrypted payload as today.
- **Exports.** Summaries and JSON backups stay **plaintext**, and the export
  panel warns that the file is not protected. An encrypted backup format
  would be a separate decision; it is not part of Task 09.

### Tests (written in Task 09)

All of the tests below exist; see [vault.md](../vault.md#evidence) and
[validation.md](../validation.md) for files, counts and CI runs.

- **Unit (Node WebCrypto):** round trip; wrong passphrase; tampering with
  the ciphertext, IV, additional data or wrapped key is rejected; each write
  gets a new IV; KDF parameters are read from the stored record; the handler
  queue serialises writes across encrypt and decrypt.
- **Migration with a fault-injecting storage fake:** fail at each step (1–5)
  and check that a restart resumes or stops safely, with no loss and no
  duplicate. A rich synthetic ledger (`tests/shared/rich-ledger.ts`) must
  come back field-for-field identical.
- **Erase while locked;** a restore from a legacy backup into an encrypted
  empty ledger; corrupt-vault handling with no automatic reset.
- **E2E: fresh encrypted installation (bundled Chromium).** Use a new
  temporary profile and enable encryption **before** any ledger data exists.
  Only then enter a synthetic canary string in a note and make further
  writes. Check that:
  - raw `chrome.storage.local` contents hold only the vault record, with no
    plaintext ledger key, no canary and no unwrapped data key;
  - after the browser is closed, the canary and the session's exported data
    key (read from `chrome.storage.session` inside the test, in the
    encodings the code could store it in) are absent from the profile's
    persistent extension-storage files for this extension;
  - the data key is not in `chrome.storage.local` or other persistent
    storage.

  Scope: this shows that a ledger which began encrypted never writes this
  canary or the data key in plaintext to those files. It is **not** a
  general secure-erasure guarantee, and it says nothing about data written
  before encryption, other profiles or exported files.
- **E2E: legacy migration (bundled Chromium, or the update harness).**
  Start from a 0.6.0 ledger that already contains the rich synthetic data
  and a canary, then migrate. Check that:
  - every field of the original ledger is identical after decryption,
    including `revision`, `lastRestore` and `ledgerEpoch`;
  - the plaintext key is removed only after the vault has been written,
    read back and verified, which a storage spy confirms by checking the
    order of operations;
  - after migration, `chrome.storage.local` returns no plaintext ledger;
  - a canary added **after** migration is never written in plaintext
    (checked through the API and in newly written storage records).

  This test must **not** require older plaintext bytes, including the
  pre-migration canary, to vanish from Chrome's database or log files. Such
  retention is expected and disclosed (see *Migration without losing
  history* above).
- **E2E: sessions.** Lock and unlock work; a service-worker restart keeps the
  session unlocked; a browser restart requires unlocking.
- **Update check:** extend `npm run test:update` so 0.6.0 is updated to the
  new version with the rich ledger, migrated, and checked for the same case
  states and backup.

### Acceptance criteria for Task 09

Status: criteria 1–6 are met by the Task 09 code, tests and documents;
criterion 7 is recorded with its CI runs in [validation.md](../validation.md).
None of this completes B2, publisher inputs, assets or store approval.

1. **Fresh encrypted installation:** in a profile where encryption is
   enabled before any data exists, no plaintext ledger and no unwrapped data
   key are written to persistent extension storage. The fresh-installation
   canary test proves this on the production build, through the API and in
   the relevant storage files, within the scope stated with that test. It is
   not presented as secure erasure.
2. **Legacy migration:** every record and field of a 0.6.0 ledger is
   identical after decryption. The plaintext key is removed only after
   encrypted persistence has been verified, and all later writes are
   encrypted. Every interruption and failure point is covered by a test,
   with no data loss and no duplicate. The test does not require historical
   plaintext bytes to disappear from Chrome's files. User-facing copy and
   the privacy policy state that pre-migration plaintext on disk and earlier
   plaintext backups or summaries are not retroactively protected.
3. Locked, unlocked, suspended, restart, wrong-passphrase, corrupt,
   rejected-write and erase-while-locked states behave as designed, and none
   of them resets data automatically.
4. Legacy plaintext backups still restore; exports are clearly labelled as
   unprotected.
5. No new permissions, network access, accounts or remote code; manifest
   permissions stay `storage`, `activeTab`, `scripting`.
6. README, the privacy policy draft and the dashboard answers are updated
   to describe the protection and its limits exactly: a forgotten passphrase
   loses data; there is no protection while unlocked; exports are plaintext.
7. Typecheck, lint, unit tests, `test:e2e`, `test:package` and `test:update`
   pass in CI.
