# Chrome Web Store listing (draft)

> **Draft, not submitted.** This text describes beta 0.6.0 as it is built
> today. Do not submit it until the open items in
> [readiness.md](readiness.md) are resolved, especially encryption at rest
> and in-product consent. Once those are implemented, update the text below,
> including every "not encrypted" statement. No customers, testimonials,
> pricing, affiliations or results are claimed.

## Name

**Refund Reconciler (local preview)**

This is the `name` in `public/manifest.json`. The store displays the
manifest name, so any change to it belongs in a later task that changes the
manifest.

## Summary (≤132 characters)

> Track refunds per returned item: expected amount, merchant reports and
> money you confirmed. Stored in your browser, never sent.

Length: 127 characters (counted with a script). The current manifest `description` is different
("Beta: manually record refund evidence for each returned item and track
what is still unresolved, kept locally in this browser."; 126 characters).
If the dashboard takes the summary from the manifest, this text can only be
used after a later manifest change. Whether it does was **not verified**,
because no developer account was used.

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

On `amazon.com` or `www.amazon.com`, you can highlight the refund line for
one item, click the toolbar button and choose **Capture selected refund
text**. The extension reads only the highlighted text and the page address,
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
- Backups and summaries are ordinary, unencrypted files. Keep them safe.

**Where your data is kept**

Everything stays in this Chrome profile, in the extension's local storage.
There is no account, server, sync, analytics or advertising, and the
developer receives none of your data. Stored records are **not encrypted**
in this version, so anyone with access to this browser profile can read
them. Removing the extension deletes its stored data, so download a backup
first if you want to keep it. See the privacy policy for details.

Scope: Amazon US orders in US dollars. Refund Reconciler is independent and
is not affiliated with or endorsed by Amazon.

**Permissions:** `storage` (keeps your records in this browser),
`activeTab` (after you click the toolbar button, temporary access to that
one tab) and `scripting` (after you choose Capture, reads the selected text
on that tab). There are no host permissions, no background page access and
no remote code.

## Reviewer instructions

No account, login, payment or test credentials are needed. All data used
below is synthetic.

1. Install the extension and pin **Refund Reconciler** from the puzzle-piece
   menu.
2. Click the toolbar icon, then **Open dashboard**. The **How to use Refund
   Reconciler** guide at the top explains the workflow.
3. Optional quick look: at the bottom of the case list, choose **Load
   synthetic demo**. Two clearly labelled fake cases appear, kept out of
   your totals. **Remove synthetic demo** deletes them again.
4. Manual flow: choose **Create case**, enter an order reference such as
   `TEST-0001`, add an item "Test item" with an expected refund of `35.00`,
   and save. Open the case, then:
   - **Record merchant report** of `35.00`: the item shows the merchant
     report, but no money is confirmed yet.
   - **Confirm money received** of `20.00`: the item shows $20.00 confirmed
     against $35.00 expected.
   - **Record recharge** of `5.00`: the confirmed net amount drops to $15.00.
   - On the merchant report, receipt or recharge, **Void…** with a reason:
     the entry stays in the history, marked as voided, and no longer counts.
     (Expected amounts are not voided; use **Edit expected amount**.)
   - Filter the case list with **Needs attention** or **Needs review**.
5. Exports: on a case, **Prepare case summary…** → **Copy** or
   **Download**. On the list, **Your data → Download all data (JSON)…**.
6. Restore: delete all cases (**Delete case…** on each, and **Remove
   synthetic demo**), then use **Restore from a JSON backup…** with the file
   from step 5.
7. Capture (optional, no account needed): open `https://www.amazon.com`,
   highlight any ordinary text (for example a product name), click the
   toolbar icon and choose **Capture selected refund text**. Expected:
   **Cannot propose a report from this selection**, with a reason. Choose
   **Discard**, and nothing is saved. On another `https` website, Capture
   says that only pages on amazon.com or www.amazon.com are supported. Saving a real captured report
   requires a real Amazon refund line for one item, which a reviewer does
   not need to test.

Nothing in these steps sends data anywhere.
