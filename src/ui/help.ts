// "How to use Refund Reconciler": a static first-use guide shown as a native
// disclosure in the dashboard header. It is built once, outside the app's
// render tree, and neither reads nor writes saved data: opening, closing or
// reading it never touches storage, drafts, filters or in-progress operations.

import { h } from './dom';

// Deliberately not "help": the popup opens dashboard.html#help, and a matching
// fragment target would make Chrome move focus away from the guide.
export const HELP_ID = 'help-guide';

export function buildHelp(): HTMLDetailsElement {
  return h(
    'details',
    { id: HELP_ID, class: 'help', 'data-testid': 'help' },
    h('summary', { id: 'help-summary' }, 'How to use Refund Reconciler'),
    h(
      'div',
      { class: 'help-body' },
      h(
        'ol',
        { class: 'help-steps' },
        h(
          'li',
          {},
          h('strong', {}, 'Create a case. '),
          'Choose Create case, add each returned item and enter the refund you expect for it, or tick Unknown if you don’t know it yet.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Optionally record what the merchant says. '),
          'Use Record merchant report to type in what the merchant says it issued, or highlight one item’s refund line on a supported Amazon US page, click the toolbar button and approve the preview. This is the merchant’s statement, not proof that you were paid.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Confirm money yourself. '),
          'After checking your card or bank statement, use Confirm money received. If money is later taken back, use Record recharge. If you entered something by mistake, Void it: the original and the void both stay in the history.',
        ),
        h(
          'li',
          {},
          h('strong', {}, 'Follow up. '),
          'Filter by Needs attention or Needs review and open a case to see what is unresolved. Prepare case summary… gives you text to share yourself; nothing is sent anywhere. Download all data (JSON)… saves a backup, which can be restored only into a ledger with no cases.',
        ),
      ),
      h(
        'p',
        {},
        'Want to look around first? Load synthetic demo (at the bottom of the case list) adds made-up example cases, clearly labelled and kept out of your totals. Remove synthetic demo deletes them again. It is never loaded for you.',
      ),
      h(
        'details',
        { class: 'help-more' },
        h('summary', {}, 'Where your data is kept'),
        h(
          'ul',
          {},
          h('li', {}, 'Everything you enter stays in this Chrome profile on this computer. It is not synced and not sent to Amazon, your bank or anyone else.'),
          h('li', {}, 'Before first use, the dashboard explains how your data is handled and asks you to agree. You can reread that explanation under Data and privacy at the top of the dashboard.'),
          h('li', {}, 'The saved ledger is encrypted with a key protected by your passphrase. You need the passphrase after Chrome restarts, after the extension is reloaded or updated, and after Lock now. There is no recovery service: a forgotten passphrase can only be handled by erasing and restoring a backup you saved.'),
          h('li', {}, 'Encryption does not protect records while they are unlocked in this browser, against malware on this computer, or with an easily guessed passphrase. If you used a version before 0.7.0, older unencrypted copies may remain in Chrome’s own files.'),
          h('li', {}, 'Backups, summaries and text you copy are ordinary, unencrypted files or text. Keep them somewhere safe and share them only if you choose to.'),
          h('li', {}, 'Removing the extension, or losing or resetting this browser profile, deletes the saved records. Download a JSON backup first if you want to keep them.'),
        ),
      ),
      h(
        'details',
        { class: 'help-more' },
        h('summary', {}, 'About capturing selected text'),
        h(
          'ul',
          {},
          h('li', {}, 'Capture is a preview feature. Its refund-wording rules have been tested only on synthetic examples, not on real Amazon refund pages, so it may not recognise the wording you see.'),
          h('li', {}, 'Capture works only after you have agreed to the data practices (Data and privacy) and while your records are unlocked. Then, opening the toolbar panel looks up the current tab’s address to check whether the page is supported; the address is only kept in memory at that point. Before you agree, or while your records are locked, the toolbar popup reads nothing from the page.'),
          h('li', {}, 'Only after you choose Capture are the highlighted text (up to 4,000 characters) and the page address read. Nothing is saved until you approve the preview and press Save; an approved capture saves the selected text, a shortened page address and the capture time with the report.'),
          h('li', {}, 'If capture doesn’t work, enter the merchant report manually instead.'),
        ),
      ),
      h('p', { class: 'muted small' }, 'Refund Reconciler tracks the evidence you record. It does not move money, contact merchants or decide what you are owed.'),
    ),
  );
}
