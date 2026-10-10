# Refund Reconciler privacy policy

> **DRAFT, not published.** Fields marked **[PENDING: …]** must be filled
> in by the publisher before this policy is posted. Do not post this draft
> until the open items in [readiness.md](readiness.md) are resolved. This
> draft describes the current build and is not legal advice.

- **Publisher:** [PENDING: publisher or developer name]
- **Contact:** [PENDING: contact email or support URL controlled by the publisher]
- **Effective date:** [PENDING: set on publication]
- **Applies to:** Refund Reconciler (local preview) Chrome extension, version 0.8.0

## Summary

Refund Reconciler is a Chrome extension for keeping track of refunds for
items you returned. It handles information you enter, and text you choose
to capture from Amazon US pages, **only inside your own Chrome profile on
your device**. The extension does not send this information to the
publisher or to anyone else. The publisher does not receive, see, sell or
share it. Stored records are **encrypted** with a key protected by a
passphrase you choose; files and text you export are not.

**You are asked first.** Before you can enter refund information, set a
passphrase, restore a backup or use capture, the extension shows an
explanation of how it handles your data inside the dashboard and asks you to
choose **Agree and continue**. If you choose **Not now**, nothing is stored or
changed and these features stay unavailable. Only a small record that you
agreed (which version of the explanation, and when) is stored in your
Chrome profile; it contains nothing else about you. You can reread the
explanation under **Data and privacy** in the dashboard.

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

- When you click the Refund Reconciler toolbar button **after you have
  agreed and while your records are unlocked**, Chrome temporarily lets the
  extension see the address of the tab you are on. The extension uses it only
  to check whether the page is supported. It is not saved at that point.
  Before you agree, while your records are locked, or before you have set a
  passphrase, the toolbar panel does not look at the tab at all; it only
  offers to open the dashboard.
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
- **The stored records are encrypted.** Before any record is saved, you
  choose a passphrase. The extension derives a key from it on your device
  (PBKDF2-HMAC-SHA-256) and uses it to protect a random AES-256-GCM key that
  encrypts the stored records. Your passphrase is never stored or sent
  anywhere.
- While your records are **unlocked**, the key is kept in Chrome's
  memory-only session storage so the extension can work. You need the
  passphrase again after Chrome restarts, after the extension is reloaded or
  updated, and after you choose **Lock now**.
- **There is no recovery service.** The publisher cannot reset or recover a
  forgotten passphrase. Without it, the stored records can only be erased;
  a backup file you saved earlier can then be restored.
- Encryption does **not** protect your records while they are unlocked in
  your browser, against malware or anyone using your device or account, or
  if your passphrase is easy to guess. Protect your device and your
  operating-system account.
- The record of your agreement is stored separately from your records and
  is not encrypted; it holds only the explanation's version number and the
  time you agreed.
- If you used a version before 0.7.0, your records were stored without
  encryption. When you update, they are encrypted only after you choose a
  passphrase, and older unencrypted copies may remain in Chrome's own files
  on your device; the extension cannot remove them.
- Web pages and the capture code that runs in a page cannot read the
  stored records; only the extension's own pages can.

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
- If your records are locked (for example because you forgot the
  passphrase), stored data cannot be read, or you have not agreed to the
  data practices, the dashboard offers **Erase stored data…**, which erases
  everything, including the record of your agreement, after you type
  `ERASE`. You do not need to agree in order to erase.
- **Removing the extension** from Chrome deletes all of its stored records.
  Download a backup first if you want to keep them.
- Losing or resetting the Chrome profile also loses the records. The
  publisher cannot recover them.
- Deleting records in the extension does not delete files you exported.
- The extension does not securely wipe the underlying storage files on
  disk, including any unencrypted copies left by versions before 0.7.0.

## Your choices

Using the extension is optional, and so is every field marked optional.
Choosing **Not now** on the data-practices explanation keeps any existing
records unchanged and leaves the extension's data features off.
Capture is optional and runs only when you ask; you can enter merchant
reports manually instead. You can view everything stored in the dashboard,
export it, and delete it as described above.

## Chrome Web Store User Data Policy

The use of information received by Refund Reconciler adheres to the Chrome
Web Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

If a future version handles data differently, for example by adding
network features or new data types, this policy will be updated
before that version is released, and the extension will show the changed
explanation prominently and ask you to agree again before the new practice
applies. The effective date above shows when this version took effect.

## Contact

Questions about this policy: [PENDING: contact email or support URL
controlled by the publisher].
