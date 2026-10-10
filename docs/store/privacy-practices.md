# Privacy practices tab: draft answers

> **Draft answers, not a certification.** They describe beta 0.6.0 as built.
> Do not enter or certify them until the open items in
> [readiness.md](readiness.md) are resolved. Those are B1 (encryption at
> rest) and B2 (in-product disclosure and consent). After those changes
> ship, revise the answers. The dashboard's own checkbox labels and
> definitions were **not inspected** (no developer account), so confirm
> every label below against the dashboard before answering.

Sources: [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy),
[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
(Q2, Q4, Q10, Q13; *Minimum Permission*),
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
fetched 2026-10-10. Code evidence uses the flow IDs (F1–F14) from
[readiness.md](readiness.md#data-flows-in-the-production-build-facts).

## Single purpose description

> Refund Reconciler helps a user track, item by item, the refunds for items
> they returned on Amazon US orders. The user records the expected refund,
> what the merchant reports was issued, money they confirmed receiving, and
> any recharges, and the extension shows what is still unresolved. An
> optional toolbar action lets the user capture a selected refund line from
> an amazon.com page as a merchant-report entry after previewing and
> approving it. All records stay in the browser.

Why this is one purpose: the summaries, backup and restore, the overview
and capture all create, read or export the same per-item refund records.
None of them serves another goal.

## Permission justifications

**`storage`**

> Stores the user's refund records (cases, items, expected amounts,
> merchant reports, confirmed receipts, recharges, voids and approved
> captures) in chrome.storage.local in their own profile. Also used to
> refresh open extension pages when records change, and to keep stored
> records out of reach of web-page contexts. Nothing is synced or sent.

Evidence: `src/persistence/storage.ts`; `src/ui/deps.ts` `subscribe`;
`src/background/service-worker.ts` `setAccessLevel`.

**`activeTab`**

> When the user clicks the toolbar button, the popup needs temporary access
> to that one tab. It checks that the page is amazon.com or www.amazon.com
> and, only if the user then chooses "Capture selected refund text", reads
> the user's highlighted text there. We use activeTab instead of host
> permissions so the extension has no standing access to any site and
> nothing runs without a click.

Evidence: `src/popup/main.ts` `sourceTab`; `src/capture/acquire.ts`
`acquireSelection`; `public/manifest.json` (no `host_permissions`, no
`tabs`).

**`scripting`**

> After the user chooses Capture, the extension runs one bundled function
> once in the main frame of the clicked tab (isolated world). That function
> returns the current text selection and the page address. It does not read
> form fields, cookies, storage or the rest of the page. No content scripts
> are declared, and no code runs on pages otherwise.

Evidence: `src/capture/acquire.ts` `chromeAcquireDeps`;
`src/capture/collector.ts` `collectSelection`.

## Remote code

**Proposed answer: "No, I am not using remote code."**

Facts: all JavaScript is bundled at build time, and the CSP is
`script-src 'self'; object-src 'none'; base-uri 'none'`. The production
build contains no `eval`, `new Function`, `importScripts`, dynamic
`import(` or network API, and the injected code is the bundled
`collectSelection` passed as `func` (see readiness.md, *Data flows*).

## Data usage: what the extension collects

The Chrome Web Store FAQ treats data that is only processed or stored
locally as handled data that must be disclosed (FAQ Q3, Q14). The answers
below therefore describe data the extension **stores on the device**, even
though the developer receives none of it. Labels follow FAQ Q4. The
dashboard may group or name them differently.

"Requested" means the UI asks for it. "Voluntary" means a user could type
or select it, although the extension does not ask for it.

| Category (FAQ Q4) | Proposed | What, exactly | Requested vs voluntary | Reasoning / uncertainty |
| --- | --- | --- | --- | --- |
| Financial and payment information | **Yes** | Expected refunds, merchant-reported refunds, amounts the user confirmed receiving, recharges, transaction references, the dates of these events (F1–F3, F6) | Requested (amounts); reference and date optional | The core of the product is a payment history for refunds. Treat it as financial information even though there are no card or bank numbers |
| Website content | **Yes** | The approved excerpt of selected text from an amazon.com page (≤4,000 chars), stored with the merchant report (F5–F6) | Requested for capture only, which is optional | FAQ Q2 lists "capturing data from a web page" as handling. It is stored only after the user approves |
| Web browsing activity / web history | **Yes (conservative)** | For each approved capture: the page origin and a sanitised path (with at most one order number) (F6). Also the active tab's URL, read when the popup opens and kept in memory only (F4) | Read on toolbar click; stored only for approved captures | FAQ Q4 defines browsing activity to include "the domains or URLs the browser interacts with". It is not a history of visited pages. If the dashboard's definition is "list of pages visited", the honest answer may still be Yes because URLs are stored. **Unresolved:** confirm against the dashboard definition and choose the more inclusive answer if in doubt. Limited Use permits this only for a user-facing feature described on the store page and in the UI; the listing does describe it |
| Personally identifiable information | **Yes (conservative), owner decision** | Not requested. Amazon order numbers are stored as order references or detected numbers, and free text (item descriptions, notes, references, sources, void reasons, excerpts) may contain names, addresses or other identifiers if the user types or selects them | Voluntary only, apart from order numbers | An order number identifies a transaction, not a person; it is arguably not an "account number". Under-disclosure is the larger risk (FAQ *Simplifying* Q3). Alternative: answer No and say in the policy that free text may contain what users enter. **Owner to decide** |
| Authentication information | No | — | Never requested; capture refuses selections inside form fields (`collectSelection`) | A user could type a secret into a note. That is voluntary and not a collection practice |
| Personal communications | No | — | — | Not read or stored |
| Health information | No | — | — | — |
| Location | No | — | No geolocation API; an address typed into free text would fall under PII above | — |
| User activity (clicks, keystrokes, scrolling) | No | — | — | Only the selection is read, once, on request. No event monitoring |
| Form data | No (separately) | — | The extension's own forms collect the categories above | FAQ Q4 lists "Form data". Here it is covered by the financial and PII rows; no form data is read from web pages |
| User-generated content | Covered above | Notes, void reasons | Voluntary | Disclosed in the policy |

## Certifications

The dashboard asks for limited-use certifications. Their exact wording was
not inspected. Based on the Limited Use page, the facts support certifying
that:

- the developer does not sell or transfer user data to third parties
  outside the permitted uses: **true** (no transmission at all);
- user data is not used or transferred for purposes unrelated to the single
  purpose: **true**;
- user data is not used or transferred to determine creditworthiness or for
  lending: **true**.

**Do not certify yet.** Certifying asserts policy compliance overall, and
B1 and B2 are open. The Limited Use statement must also be hosted on a site
belonging to the extension. That is pending publisher input; the text is in
the [policy draft](privacy-policy.md).

## Privacy policy URL

**[PENDING: privacy policy URL on a site the publisher controls]**. Host
[privacy-policy.html](privacy-policy.html) only after the publisher fields
are filled in and the policy text matches the build being submitted.

## Changes that would require fresh disclosure

Any of these would change the answers above. They would need an updated
policy, an updated dashboard answer and a prominent in-product notice before
release: network requests of any kind, sync, analytics or crash reporting,
accounts, support uploads, AI or remote processing, new capture sites or
whole-page extraction, new permissions, encryption or backup format
changes, or any change in who can access the data.
