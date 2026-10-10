# Refund Reconciler privacy policy

> **DRAFT, not published.** Fields marked **[PENDING: …]** must be filled
> in by the publisher before this policy is posted. Do not post this draft
> until the open items in [readiness.md](readiness.md) are resolved. This
> draft describes the current build and is not legal advice.

- **Publisher:** [PENDING: publisher or developer name]
- **Contact:** [PENDING: contact email or support URL controlled by the publisher]
- **Effective date:** [PENDING: set on publication]
- **Applies to:** Refund Reconciler (local preview) Chrome extension, version 0.6.0

## Summary

Refund Reconciler is a Chrome extension for keeping track of refunds for
items you returned. It handles information you enter, and text you choose
to capture from Amazon US pages, **only inside your own Chrome profile on
your device**. The extension does not send this information to the
publisher or to anyone else. The publisher does not receive, see, sell or
share it. Stored records are **not encrypted** in this version.

## What information the extension handles

**Information you type in.** For each case you create:

- an optional order reference;
- descriptions of the returned items;
- expected refund amounts (or "unknown");
- entries you record: merchant reports, money you confirmed receiving, and
  recharges, each with an amount and optionally a date, a transaction or
  observation reference, a source and a note;
- reasons you give when you void a mistaken entry;
- the time each entry was recorded.

This is financial information about your purchases and refunds. The
extension does not ask for your name, address, email, account login, card
numbers or bank details. Free-text fields (order reference, item
description, reference, source, note, void reason) accept anything you type,
so do not enter information you do not want stored.

**Information from a web page, only when you capture.** The capture feature
works only on `https://amazon.com` and `https://www.amazon.com`:

- When you click the Refund Reconciler toolbar button, Chrome temporarily
  lets the extension see the address of the tab you are on. The extension
  uses it only to check whether the page is supported. It is not saved.
- When you then choose **Capture selected refund text**, the extension reads
  the text you highlighted (up to 4,000 characters) and the page's address.
  It does not read the rest of the page, form fields, passwords, cookies or
  other tabs, and it takes no screenshots.
- The extension shows you a preview. **Nothing is saved unless you approve
  it.** If you approve, it saves the highlighted text, the page's address
  (shortened: tracking parts and all query parameters except a single
  order number are removed), the capture time, the amount text you
  approved and any order number found, together with the merchant report.
- If you discard or close a preview **before** choosing **Save merchant
  report**, nothing is saved.
- Once you choose **Save merchant report**, the approved report is sent to
  be saved. Closing the panel or choosing **Stop waiting** afterwards does
  not undo that save. If the panel could not confirm the outcome, open the
  case in the dashboard to check whether the report was recorded before you
  capture the same text again. If it was recorded and you do not want it,
  void it there or delete the case.

**Backup files you choose to restore.** If you use **Restore from JSON**,
the file you pick is read on your device and its records are saved into the
extension.

**Synthetic demo.** If you choose **Load synthetic demo**, made-up example
records are saved until you remove them.

## How the information is used

Only to provide the extension's single purpose: showing you, item by item,
which refunds are expected, reported, confirmed, reversed or still
unresolved, and letting you create summaries and backups. It is not used for
advertising, profiling, creditworthiness or lending decisions, analytics or
any other purpose.

## Where it is stored and how it is protected

- Records are stored in Chrome's extension storage (`chrome.storage.local`)
  in your Chrome profile on your device. They are not synced to other
  devices by the extension.
- Web pages and the capture code that runs in a page cannot read the
  stored records; only the extension's own pages can.
- **The stored records are not encrypted by the extension.** Anyone or
  any software that can read your Chrome profile or your device's files
  could read them. Protect your device and your operating-system account.

## Sharing and transmission

- The extension makes **no network requests**. It has no analytics,
  advertising, tracking, remote code or AI services, and no account or
  server.
- The publisher has no access to your records and does not transfer them to
  anyone.
- **Your own exports.** If you copy a case summary to the clipboard or
  download a summary or a JSON backup, the result is an ordinary,
  **unencrypted** file or clipboard text that you control. The extension
  cannot track or delete it. Anyone you share it with, and any app that can
  read your clipboard or files, may be able to read it. Summaries leave out
  notes, references and captured text unless you choose to include them. A
  JSON backup contains all stored records.

## How long it is kept and how to delete it

Records are kept until you delete them, remove the extension, or the Chrome
profile is deleted or lost.

- **Delete case…** permanently removes a case and all its records.
- **Remove synthetic demo** removes the demo records.
- If stored data cannot be read, the dashboard offers **Erase stored
  data…**, which erases everything.
- **Removing the extension** from Chrome deletes all of its stored records.
  Download a backup first if you want to keep them.
- Losing or resetting the Chrome profile also loses the records. The
  publisher cannot recover them.
- Deleting records in the extension does not delete files you exported.
- The extension does not securely wipe the underlying storage files on
  disk.

## Your choices

Using the extension is optional, and so is every field marked optional.
Capture is optional and runs only when you ask; you can enter merchant
reports manually instead. You can view everything stored in the dashboard,
export it, and delete it as described above.

## Chrome Web Store User Data Policy

The use of information received by Refund Reconciler adheres to the Chrome
Web Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

If a future version handles data differently, for example by adding
encryption, network features or new data types, this policy will be updated
before that version is released, and the extension will show the change
prominently. The effective date above shows when this version took effect.

## Contact

Questions about this policy: [PENDING: contact email or support URL
controlled by the publisher].
