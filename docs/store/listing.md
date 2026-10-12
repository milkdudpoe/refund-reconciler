# Chrome Web Store listing (draft)

> **Prepared, not submitted.** This text describes beta 0.8.0 as it is
> built today. The owner chose an **unlisted free beta**; the paste-ready
> copy is bundled by `npm run store:handoff` (see
> [submission-handoff.md](submission-handoff.md)). Before the owner submits:
> the 0.8.0 desktop Chrome check (**not run**), an explicit decision on the
> untested real refund wording, and the owner's own Developer Dashboard
> privacy declarations. Google's review follows submission. The privacy
> policy is live at
> `https://milkdudpoe.github.io/refund-reconciler/privacy.html` (publisher
> MJUD, contact `exiledeals@gmail.com`; [publication.md](publication.md)).
> The store images are done but not uploaded ([assets.md](assets.md)).
> No customers, testimonials, pricing, affiliations or results are claimed.

## Name

**Refund Reconciler (local preview)**

This is the `name` in `public/manifest.json`. The store displays the
manifest name, so any change to it belongs in a later task that changes the
manifest.

## Summary (≤132 characters)

> Track refunds per returned item: expected amount, merchant reports and
> money you confirmed. Stored in your browser, never sent.

Length: 127 characters (counted with a script). **Not used for the 0.8.0
submission.** Chrome takes the description from the manifest in the ZIP and
it cannot be edited in the dashboard
([Prepare your extension](https://developer.chrome.com/docs/webstore/prepare),
checked 2026-10-12), so the store shows the current manifest `description`:
"Beta: manually record refund evidence per returned item and track what is
unresolved, kept locally and encrypted by passphrase." (127 characters).
This summary could only be used after a later manifest change.

## Detailed description

Refund Reconciler helps you keep track of refunds for items you returned,
one item at a time, so you can see what is still unresolved. It is a
record-keeping tool. It does not request refunds, contact merchants, check
your bank, move money or decide what you are owed.

**Record what you expect and what happened, per item**

- Create a case for an order, add each returned item, and enter the refund
  you expect for it, or mark the amount as unknown.
- Record a **merchant report** when the merchant says a refund was issued.
  A merchant report is the merchant's statement, not proof that you were
  paid. A newer report for the same item replaces the earlier one rather
  than adding to it.
- After checking your own card or bank statement, record **money received**
  for the item. Only these confirmed receipts count as received.
- If money is taken back, record a **recharge**. If you entered something by
  mistake, **void** it: the original and the void both stay in the history.

**See what needs attention**

Each item shows whether its refund is unknown, unconfirmed, partially
confirmed, reopened after a recharge, settled, or needs review (for example,
when more is confirmed than expected, or the merchant reports less than you
confirmed). You can filter cases by **Needs attention** or **Needs review**
and search by order reference or item description. Amounts are never moved
between items.

**Optional: capture a refund line from an Amazon US page (preview)**

After you have agreed to the data practices, and while your records are
unlocked, on `amazon.com` or `www.amazon.com`, you
can highlight the refund line for one item, click the toolbar button and
choose **Capture selected refund text**. The extension reads only the
highlighted text and the page address,
and shows a preview of the amount it found. Nothing is saved until you
choose the case and item, confirm that the amount is for that one item, and
approve. If you approve, it saves the highlighted text and a shortened page
address with the merchant report so you can see later where it came from.

This feature is limited. It understands only certain US-dollar refund
wording. It has been tested on example text, not on real Amazon refund
pages, so it may not recognise what you see. Other sites and other Amazon
country sites are not supported. You can always enter the merchant report
manually instead.

**Summaries, backup and restore**

- **Prepare case summary** creates plain text you can copy or download and
  share yourself, for example when you contact support. Notes, references
  and captured text are left out unless you include them.
- **Download all data (JSON)** saves a complete backup file. **Restore from
  JSON** brings a backup back into a dashboard that has no cases.
- Backups, summaries and copied text are ordinary, unencrypted plaintext.
  Keep them safe.

**Where your data is kept**

Before you can enter anything, the dashboard explains how your data is
handled and asks you to choose **Agree and continue** (or **Not now**, which
changes nothing). You can reread it under **Data and privacy**.
Everything stays in this Chrome profile, in the extension's local storage.
There is no account, server, sync, analytics or advertising, and the
extension sends none of your data to the developer. Stored records are **encrypted** with
a key protected by a passphrase you choose; you need it after Chrome
restarts, after updates and after **Lock now**. **There is no recovery
service:** a forgotten passphrase means erasing the records and restoring a
backup you saved. Encryption does not protect records while they are
unlocked, against malware, or with a weak passphrase, and plaintext left by
versions before 0.7.0 may remain in Chrome's files. Removing the extension
deletes its stored data, so download a backup first if you want to keep it.
See the privacy policy for details.

Scope: Amazon US orders in US dollars. Refund Reconciler is independent and
is not affiliated with or endorsed by Amazon.

**Permissions:** `storage` (keeps your encrypted records in this browser),
`activeTab` (after you click the toolbar button, temporary access to that
one tab) and `scripting` (after you choose Capture, reads the selected text
on that tab). There are no host permissions, no background page access and
no remote code.

## Reviewer instructions

The short, paste-ready test steps for the dashboard's optional Test
instructions tab are [handoff/reviewer-instructions.txt](handoff/reviewer-instructions.txt)
(synthetic data only, no shared credentials; the reviewer chooses a
throwaway passphrase). They cover disclosure and setup, manual recording,
summary and backup, lock and unlock, and the optional toolbar refusal of
ordinary Amazon text, and they state that real refund capture is untested.
The longer walkthrough that stood here (demo data and restore) is in git
history and in [../beta.md](../beta.md).
