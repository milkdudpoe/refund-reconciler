# Privacy tab: answers for Refund Reconciler {{VERSION}}

Prepared for the owner to review and enter. **Nothing here has been entered,
checked or certified.** The paste-ready answers in part A are quoted from
`docs/store/privacy-practices.md`. Part B lists proposed data-type answers;
part C lists what only the owner can decide on the dashboard.

Chrome documentation used, checked {{DOCS_CHECKED}}:
[Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
(fields: single purpose, permission justification, remote code, data usage,
certifications, privacy policy). The dashboard's own checkbox names and
definitions appear there only as a screenshot and were **not inspected in
the owner's account**; match every answer to the dashboard's wording.

## A. Facts about the build (paste-ready)

**Single purpose**

> {{SINGLE_PURPOSE}}

**Permission justifications.** The manifest requests exactly `storage`,
`activeTab` and `scripting`; no host permissions, no content scripts.

`storage`:

> {{JUSTIFY_STORAGE}}

`activeTab`:

> {{JUSTIFY_ACTIVETAB}}

`scripting`:

> {{JUSTIFY_SCRIPTING}}

**Remote code:** choose **"No, I am not using remote code."** All JavaScript
is bundled in the ZIP; the extension pages' CSP is
`script-src 'self'; object-src 'none'; base-uri 'none'`; the one injected
function is bundled code passed to `chrome.scripting.executeScript`.

**Privacy policy URL:** {{POLICY_URL}} (live since 2026-10-11, effective
2026-10-11, publisher {{PUBLISHER}}, contact {{CONTACT}}). It states the
Chrome Web Store Limited Use commitment at `#chrome-web-store-user-data-policy`.

**Handling facts.** Everything the user enters or approves is stored only in
this Chrome profile (`chrome.storage.local`), encrypted with a key wrapped by
the user's passphrase. The extension makes no network requests and has no
account, server, sync, analytics or advertising; the developer receives no
user data. Chrome's policy still counts data that is only stored or processed
on the device as handled data, so the local handling below **must still be
disclosed**.

## B. Proposed data-type answers (conservative)

| Dashboard data type (likely label) | Proposed | What the extension handles | Why / uncertainty |
| --- | --- | --- | --- |
| Financial and payment information | **Yes** | Expected, merchant-reported, received and recharged refund amounts, references and dates | Core of the product; no card or bank numbers |
| Website content | **Yes** | The highlighted text from an amazon.com page, stored only after the user approves a capture | Optional feature; nothing stored before approval |
| Web history / browsing activity | **Yes (conservative)** | For approved captures, the page origin and a shortened path; the active tab's address, read in memory when the popup opens (after agreement, while unlocked) | Not a history of visited pages. If the dashboard defines it as "pages visited", Yes is still the safer answer because URLs are stored |
| Personally identifiable information | **Yes (conservative)** | Amazon order numbers; free text that a user may type (names, addresses) | An order number identifies a transaction, not a person; answering No is arguable. Under-disclosure is the larger risk |
| Authentication information | **Yes (conservative)** | The vault passphrase, processed on the device to derive a key; never stored, logged or sent | Processing counts as handling; no site passwords are read |
| Personal communications, health, location, user activity | **No** | — | Not read or stored; the selection is read once, on request |

## C. Owner decisions (not made here)

1. **Dashboard mapping.** Read each data-type definition in your dashboard
   and confirm or change every row of part B. Unresolved: whether browsing
   activity, PII and authentication information apply under the dashboard's
   own wording. The recommendation is to keep the conservative "Yes" when in
   doubt.
2. **Certifications.** The facts support the three Limited Use statements
   (no sale or transfer to third parties, no use unrelated to the single
   purpose, no use for creditworthiness or lending): the extension sends
   nothing at all. Certifying is your own declaration about the whole
   submission; tick them only after reading the dashboard wording and
   completing the checks in OWNER-START-HERE.md. Google's review is a later
   outcome and is not needed before you certify or submit.
3. **Policy match.** Before submitting, confirm the live policy still
   describes this ZIP (version {{VERSION}}, permissions above). Any change to
   data practices would need a new policy, new answers and a new in-product
   agreement.

A working HTTPS policy URL does not mean the publisher is verified or that
the developer account is set up; neither has been checked.
