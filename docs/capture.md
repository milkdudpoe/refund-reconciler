# Selected-text capture (Task 02)

The first capture slice. You highlight a refund record on an Amazon US page,
the extension reads **only that selected text**, previews what it understood,
and saves a merchant-report snapshot to an existing case and item **only after
you explicitly approve it**.

This is not automatic reconciliation and has not been validated against live
Amazon pages. Whole-page extraction, order-history crawling and live retailer
compatibility testing are later work.

## Flow

1. On an `https://www.amazon.com/…` or `https://amazon.com/…` page, highlight
   the refund line for **one item**, for example `Refund issued: $35.00`.
2. Click the Refund Reconciler toolbar button. The popup offers
   **Capture selected refund text** and **Open dashboard**.
3. Choose **Capture**. The popup shows a preview, marked *not saved yet*. It
   lists the excerpt, source page, detected issued amount, order number and
   date, the amounts it did **not** treat as issued, and why a proposal could
   not be made.
4. Choose a case and an item. Nothing is chosen automatically: there is no
   matching by amount, item title or order number. Synthetic demo cases are not
   offered.
5. Tick the confirmation that the amount is the refund for that one item, then
   choose **Save merchant report**.

Cancelling, discarding or closing the popup before saving leaves stored data
unchanged. No preview is stored anywhere; the popup holds it in memory only.
If you have no case yet, the popup links to the dashboard's *Create case*
screen. Create the case, then capture again.

### What a save does and does not do

A save appends **one** `merchant_report` entry to the chosen item. That is a
dated snapshot of what the merchant says it has issued for that item in total.
A save never:

- records a receipt (money you confirm arrived), a recharge, or a void;
- changes the expected amount;
- treats the merchant's statement as proof that money arrived. *Issued* stays
  separate from user-confirmed receipt. With $70 expected and no receipt, a $70
  capture leaves the item *Merchant reports issued · receipt unconfirmed*.

Reports are snapshots: the latest active one is shown and they are never
summed. A later capture of the same text is a new dated snapshot. Nothing is
deduplicated by amount or content hash.

## Browser access and permissions

| Permission | Why |
| --- | --- |
| `storage` | Saves cases in `chrome.storage.local` (unchanged from Task 01). |
| `activeTab` | Clicking the toolbar button gives temporary access to the tab you are on. Access ends when you navigate away or close the tab. |
| `scripting` | Lets the popup run the bundled selection reader in that tab after you choose Capture. |

There are no host permissions, no `tabs` permission, no `<all_urls>`, no
content scripts declared in the manifest, and no background scanning.

- **Grant path.** Only the toolbar button grants access. The popup records
  the active tab's id once, when it opens, and every step targets that tab id.
  It therefore never reads the dashboard or another tab. Opening the dashboard
  does not grant access to anything.
- **Allowed pages.** HTTPS only, and the parsed hostname must be exactly
  `amazon.com` or `www.amazon.com` on the default port, with no credentials in
  the URL. Lookalike hosts (`www.amazon.com.evil.example`), other Amazon
  country sites (`amazon.co.uk`, `amazon.ca`, …), `smile.amazon.com`, `http:`,
  `file:` and browser pages are all rejected. The check runs on the tab URL
  before injection. It runs again on the URL reported by the injected code, so
  a navigation in between is detected. A different origin, a closed tab or
  lost access ends the capture with an explanation, and nothing is saved.
- **What runs in the page.** One small function bundled in `popup.js` and
  passed to `chrome.scripting.executeScript` with `frameIds: [0]` and
  `world: 'ISOLATED'`. It returns `location.href` and
  `window.getSelection().toString()`, and nothing else. It does not walk the
  DOM, click anything, read form fields, cookies, storage, history or hidden
  application state, or take screenshots. It refuses:
  - an empty selection;
  - a selection inside an input, textarea, select or editable region;
  - a selection longer than **4,000 characters**. The over-limit text is never
    returned or parsed. You are asked to select less.
- **Untrusted input.** The page result is shape-checked. All page-derived text
  is rendered with text nodes only, never as markup.
- **Ledger isolation.** The service worker calls
  `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`,
  so code running in web pages, including our own collector, cannot read or
  write the ledger. The service worker also ignores messages from
  non-extension pages. Every change still goes through its serialised queue.
- **No network.** No requests, no telemetry, no external model calls, and no
  logging of excerpts or account data.

## Supported excerpt patterns (parser `amazon-us-selection-1`)

The parser is a small deterministic function (`src/capture/parse.ts`). It uses
no AI and produces no confidence scores. The patterns below are **parser
contracts tested with synthetic examples. They are not evidence of Amazon's
current wording.**

An amount is proposed as **issued** only when all of the following hold:

- It appears in a statement (a line or sentence) with issued wording:
  `refunded`, or `refund` together with `issued`. Supported shapes:
  - `Refund issued: $70.00` · `Refund issued $70.00` · `Refund issued for $70.00`
  - `Refunded: $70.00` · `Amount refunded: $70.00` · `$70.00 refunded to Visa ending in 1234`
  - `Your refund of $70.00 has been issued.` · `We’ve issued a refund of $70.00 …`
  - A label line followed by value lines: `Refund issued` / `October 3, 2026` / `$70.00`
- That statement contains exactly one `$` amount and no pending, expected,
  estimated, future-tense, negated, price, paid, fee, charge, recharge or
  reversal wording.
- There is exactly one such statement in the whole selection.
- The amount passes the existing strict cent parser: no sign, at most two
  decimals, valid digit grouping, at most $1,000,000,000.00, and not zero.

Optional fields:

- **Order number:** an Amazon order ID (`123-1234567-1234567` or
  `D01-1234567-1234567`) anywhere in the selection. Two or more different IDs
  make it ambiguous, and no proposal is made.
- **Date issued:** a single valid `Month D, YYYY` date inside the issued
  statement. Several dates, an invalid date, a date only elsewhere in the
  selection, or another format such as `10/03/2026` leave it **unknown**.

No proposal is made, and the popup explains why and suggests narrowing the
selection or using manual entry, when the selection:

- has no issued amount, for example only `Item price`, `Order total`,
  `Expected/Estimated refund`, `Refund pending`, `Return received` or `charged`
  amounts. These are listed as *not treated as issued*;
- has more than one issued statement. The largest or first amount is never
  chosen, even when the amounts are equal;
- mixes refund wording with pending, price or charge wording, or with several
  amounts in one statement;
- looks like an **order-level total** (`Refund total`, `Total refund`,
  `Refund summary`, `for this order`, `all items`, `N items`, `Order total` in
  the issued statement). An aggregate refund is never assigned to one item,
  split, or used to settle several items;
- mentions another currency (`€`, `£`, `CA$`, `EUR`, …) or contains a
  malformed amount.

The selection is normalised before parsing and storage: line endings, runs of
spaces, non-breaking spaces and blank lines are collapsed, and zero-width and
bidirectional control characters are removed. Visible text is otherwise kept.

## Assignment checks

- You must choose the case and the item yourself.
- If the selection names an order and the case's order reference contains a
  **different** recognisable Amazon order ID, the popup flags it and Save
  stays disabled. The service worker also refuses it. If the case has no
  recognisable order ID, the popup says the order could not be checked.
- Synthetic demo cases are never offered, and the service worker refuses
  captured evidence for them.
- Before writing, the service worker re-runs the parser on the approved
  excerpt. It only stores an entry whose amount, amount text, order and date
  are exactly what the parser derives.

## Stored provenance

A captured merchant report is an ordinary `merchant_report` entry with source
`Amazon page selection (captured)` plus an optional `capture` object:

```
capture {
  sourceOrigin       'https://www.amazon.com' | 'https://amazon.com'
  sourcePath         path without 'ref=…' tracking segments, plus '?orderID=…'
                     if it is a valid order ID; other query parameters and the
                     fragment are dropped (null if unusual or > 300 chars)
  capturedAt         ISO time the selection was read
  excerpt            the normalised excerpt you approved (≤ 4,000 chars)
  parserVersion      'amazon-us-selection-1'
  approvedAmountText the literal amount text you approved, e.g. '$70.00'
  detectedOrderRef   the single order ID in the excerpt, or null
  itemApplicabilityConfirmed  true
}
```

The provenance is validated at runtime when it is stored and on every read.
The amount text must appear in the excerpt and equal the entry's amount. The
dashboard shows it in the evidence timeline, with the approved excerpt behind
a disclosure, and states that it is the merchant's statement, not
confirmation of receipt. Voiding a captured report keeps the original entry
and its provenance in the timeline.

**Compatibility.** The field is optional, so the schema version stays `1`.
Task 01 data, including manual merchant reports, cases and voids, reads
unchanged, and new entries are appended without altering existing ones. A
Task 01 build would treat data that contains a captured entry as unreadable.
It would show that data read-only and block changes, but would not reset it.

## Retries and uncertain outcomes

Each Capture click creates a capture operation ID (`cap-…`). It becomes the
entry ID and is reused for every save attempt of that preview.

- **Retry or double submit** of the same approved operation → `duplicate`, no
  second observation.
- **Same ID with any different content**, including different provenance →
  `conflict`. Nothing is overwritten.
- **Write rejected** by `chrome.storage` (for example, quota) → reported as
  not saved. The preview, case, item and confirmation are kept, and saving
  again reuses the same ID.
- **Lost reply** → the popup does not claim success or failure. It re-reads
  storage for the operation's ID. If found, it reports *saved* and does not
  offer the report for re-entry. If not found, it keeps the preview and says a
  retry is safe. If the entry appears later, the popup switches to *saved*.

## What was verified, and what was not

Verified by automated tests in this repository:

- Parser contracts, URL checks and sanitisation, acquisition error mapping,
  ledger and validation rules, and handler retries (Vitest).
- In real Chromium with the built extension (Playwright):
  - the real collector, run through `chrome.scripting.executeScript` against
    **synthetic** HTML fixtures served at `https://www.amazon.com/…` by
    in-browser routing, with no network;
  - the real popup, the service-worker message boundary and
    `chrome.storage.local`;
  - all Task 02 acceptance outcomes;
  - that page-context code is refused ledger storage access.

**Grant-path limitation.** The test browser cannot perform a real toolbar
click or keyboard shortcut, so the `activeTab` grant itself is not exercised.
CDP `Extensions.triggerAction` is unavailable in this Chromium build, and
synthetic key events do not reach extension command shortcuts. Capture tests
therefore load an **isolated temporary copy** of `dist/` whose manifest adds
host permissions for the synthetic fixture hosts only. The popup is opened as
a background tab next to the fixture tab, which does not prove that a user
gesture granted access. Separately, the unmodified production build is tested:

- its manifest has exactly `storage`, `activeTab` and `scripting`, no host
  permissions and no content scripts;
- `dist/manifest.json` equals `public/manifest.json`;
- without a gesture it cannot see the tab URL;
- `chrome.scripting.executeScript` refuses to inject.

Test permissions never enter `dist/`.

**Not verified:** behaviour on real, signed-in Amazon US pages; Amazon's
current refund wording and how its pages produce `Selection.toString()` text;
and the manual toolbar-click flow in a desktop Chrome profile. These need
live, user-consented validation before anyone relies on this capture.
