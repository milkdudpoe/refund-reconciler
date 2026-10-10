// The one shared definition of this extension's data practices: the version
// the service worker requires before any data feature runs, and the text the
// dashboard shows before asking for agreement. Both come from this module, so
// what is displayed and what is enforced cannot drift apart.
//
// DATA_PRACTICES_VERSION is independent of the extension version. Bump it
// (and update the text) only when the data practices themselves change, for
// example a new data type, a new use, or data leaving the browser. Every
// installation is then asked to agree again before those practices run.
// Ordinary fixes, restarts and updates that keep the practices unchanged must
// not change it. See docs/consent.md.

export const DATA_PRACTICES_VERSION = 1;

export interface PracticeSection {
  readonly id: string;
  readonly title: string;
  readonly points: readonly string[];
}

export interface DataPractices {
  readonly version: typeof DATA_PRACTICES_VERSION;
  readonly heading: string;
  readonly intro: string;
  readonly sections: readonly PracticeSection[];
}

export const DATA_PRACTICES: DataPractices = {
  version: DATA_PRACTICES_VERSION,
  heading: 'How Refund Reconciler handles your data',
  intro:
    'Please read this before you enter refund information, set a passphrase, restore a backup or use capture. Nothing is collected until you agree, and agreeing does not save anything by itself.',
  sections: [
    {
      id: 'purpose',
      title: 'Purpose',
      points: ['Refund Reconciler helps you track, item by item, the refund evidence you record for Amazon US returns. It does not move money or decide what you are owed.'],
    },
    {
      id: 'typed',
      title: 'What you type or import',
      points: [
        'Optional order references, item descriptions, amounts, dates, notes, sources, transaction or observation references and void reasons that you enter.',
        'Choosing a JSON backup reads its contents in this browser; restoring it saves them into an empty ledger.',
        'Avoid entering information you do not want kept.',
      ],
    },
    {
      id: 'capture',
      title: 'Optional capture from Amazon US pages',
      points: [
        'Only after you agree and unlock your records: opening the toolbar panel looks up the active tab’s address to check whether the page is supported.',
        'Pressing Capture reads the text you highlighted (up to 4,000 characters) and the page address, on supported Amazon US pages only.',
        'If you approve the preview and press Save, the excerpt, a shortened (sanitized) source address, the capture time and the related report details are saved.',
        'The extension does not read the rest of the page, form fields, passwords, cookies or other tabs.',
      ],
    },
    {
      id: 'use',
      title: 'Use and sharing',
      points: [
        'Your data stays in this Chrome profile and is used only for these refund-tracking features.',
        'It is not sent to the publisher or any other service, not synced, and not used for advertising or analytics.',
        'You decide whether to share the exports you make.',
      ],
    },
    {
      id: 'storage',
      title: 'Storage and retention',
      points: [
        'Saved records are encrypted with a key protected by a passphrase you choose, and kept until you delete them or erase stored data.',
        'Your passphrase is used in this browser only and is not stored. The unlocked key is kept for the browser session. There is no recovery service.',
        'JSON backups, case summaries and copied text are not encrypted.',
        'Plaintext saved by versions before 0.7.0, and files you exported earlier, are not retroactively protected or securely wiped.',
      ],
    },
    {
      id: 'control',
      title: 'Your choices',
      points: [
        'Not now keeps any existing records unchanged; data features stay unavailable until you agree.',
        'After agreeing and unlocking your records, you can delete individual cases.',
        'Without agreeing or knowing your passphrase, you can still remove all stored records at once with Erase stored data… after typing the confirmation. This cannot be undone.',
        'Agreeing does not capture or save anything. Each capture still needs your approval and Save; closing or discarding it before Save writes nothing, and once you press Save, closing the panel does not undo a save that already completed.',
        'You can reread this under Data and privacy in the dashboard. If these practices change, you will be asked again.',
      ],
    },
  ],
};
