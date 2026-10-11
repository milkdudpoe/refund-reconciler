// Dashboard screens for every state other than "unlocked": Protect your
// records (setup), migration of an earlier version's plaintext records,
// unlock, and the typed Erase stored data… recovery path. While one of these
// is shown, nothing else of the ledger is rendered and no record is read.
//
// Passphrases live only in the input elements below (never in other page
// state, storage, logs or URLs) and are cleared as soon as they are sent to
// the service worker, which derives the key. See docs/vault.md.

import { ERASE_CONFIRMATION } from '../background/messages';
import { buildBackup, exportFilename, serializeBackup } from '../export/backup';
import { PASSPHRASE_MAX_BYTES, PASSPHRASE_MIN_CODE_POINTS, PASSPHRASE_PROBLEM_MESSAGE, checkPassphrase } from '../vault/passphrase';
import { legacyBackupAvailable, type LedgerState } from '../vault/state';
import type { DashboardDeps } from './deps';
import { h } from './dom';

type Tone = 'success' | 'error' | 'info';
type Locked = Exclude<LedgerState, { status: 'ok' }>;

const BACKUP_BUSY = 'Reading your plaintext records…';

/** What the user types to confirm an erase. */
export const ERASE_TYPED = 'ERASE';

export interface VaultHost {
  deps: DashboardDeps;
  render: () => void;
  announce: (text: string) => void;
  setNotice: (tone: Tone, text: string) => void;
  /** Re-reads the state from the service worker and re-renders. */
  reload: () => Promise<void>;
}

export interface VaultScreens {
  render(state: Locked): Node;
  /** The typed erase control, also used by the screen for unreadable earlier-version data. */
  renderErase(): Node;
  /** Forget any half-finished form (e.g. when the state changes underneath it). */
  reset(): void;
  /**
   * Called by the dashboard on every state-change signal (storage change,
   * Lock, unlock, erase, migration) and whenever a read shows a different
   * state. A plaintext backup still being prepared is then abandoned: its
   * reply is discarded unused, and no download starts.
   */
  invalidateBackup(): void;
}

function passwordInput(id: string, autocomplete: string, describedBy: string): HTMLInputElement {
  return h('input', {
    id,
    type: 'password',
    autocomplete,
    spellcheck: 'false',
    autocapitalize: 'off',
    'aria-describedby': describedBy,
    // Generous DOM limit; the exact byte rule is checked on submit. Pasting is allowed.
    maxlength: PASSPHRASE_MAX_BYTES,
  });
}

export function createVaultScreens(host: VaultHost): VaultScreens {
  const { deps } = host;
  // Created once and reused, so a re-render never loses what is being typed.
  const newPass = passwordInput('vault-new', 'new-password', 'vault-rules');
  const confirmPass = passwordInput('vault-confirm', 'new-password', 'vault-rules');
  const unlockPass = passwordInput('vault-unlock', 'current-password', 'vault-unlock-hint');
  const eraseInput = h('input', { id: 'erase-typed', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'erase-hint' });
  let show = false;
  let acknowledged = false;
  let busy: string | null = null;
  let errors: Record<string, string> = {};
  let feedback: { tone: Tone; text: string } | null = null;
  let confirmErase = false;
  /** On the pending-migration screen: the user chose to start again with a new passphrase. */
  let restarting = false;
  /** The plaintext backup being prepared, if any. Replaced (never reused) by invalidateBackup(). */
  let backupOp: object | null = null;
  /** Whether the visible message describes a plaintext backup (cleared with the state it describes). */
  let feedbackFromBackup = false;

  function setShow(on: boolean): void {
    show = on;
    for (const el of [newPass, confirmPass, unlockPass]) el.type = on ? 'text' : 'password';
  }

  function clearCredentials(): void {
    newPass.value = '';
    confirmPass.value = '';
    unlockPass.value = '';
    setShow(false);
  }

  function reset(): void {
    invalidateBackup();
    clearCredentials();
    acknowledged = false;
    errors = {};
    feedback = null;
    confirmErase = false;
    restarting = false;
    eraseInput.value = '';
  }

  function say(tone: Tone, text: string): void {
    feedbackFromBackup = false;
    feedback = { tone, text };
    host.announce(text);
  }

  function invalid(el: HTMLInputElement, key: string): void {
    if (errors[key]) {
      el.setAttribute('aria-invalid', 'true');
      el.setAttribute('aria-errormessage', `${el.id}-error`);
    } else {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-errormessage');
    }
  }

  function fieldError(id: string, key: string): Node | null {
    return errors[key] ? h('span', { class: 'field-error', id: `${id}-error` }, errors[key]) : null;
  }

  function showToggle(): Node {
    return h(
      'div',
      { class: 'field checkbox' },
      h('input', { id: 'vault-show', type: 'checkbox', checked: show, on: { change: (ev) => { setShow((ev.target as HTMLInputElement).checked); } } }),
      h('label', { for: 'vault-show' }, 'Show passphrase'),
    );
  }

  function feedbackNode(): Node | null {
    return feedback ? h('p', { class: `notice notice-${feedback.tone}`, role: feedback.tone === 'error' ? 'alert' : null, 'data-testid': 'vault-feedback' }, feedback.text) : null;
  }

  function progress(): Node | null {
    return busy ? h('p', { class: 'muted', 'data-testid': 'vault-progress' }, busy) : null;
  }

  // ---- Shared explanation (shown before setup and migration) ----

  function explanation(existing: boolean): Node {
    return h(
      'div',
      { class: 'vault-explain', 'data-testid': 'vault-explain' },
      h(
        'ul',
        {},
        h('li', {}, existing
          ? 'Your refund evidence stays in this browser profile. This step encrypts the records you already have, and every later change, with a key protected by a passphrase you choose.'
          : 'Your refund evidence stays in this browser profile. The extension encrypts the saved ledger with a key protected by a passphrase you choose.'),
        h('li', {}, 'You will need this passphrase after Chrome restarts, after the extension is reloaded or updated, and after you choose Lock now.'),
        h('li', { 'data-testid': 'vault-no-recovery' }, h('strong', {}, 'There is no recovery service. '), 'Nobody, including the extension, can reset or recover a forgotten passphrase. Without it, the only way back is to erase the stored data and restore a plaintext JSON backup you saved yourself.'),
        h('li', {}, 'JSON backups, case summaries and anything you copy to the clipboard are not encrypted. Anyone who can open them can read them.'),
        h('li', {}, 'Encryption does not protect your records while they are unlocked in this browser, against malware on this computer, or if your passphrase is easy to guess.' + (existing ? ' It also cannot remove older plaintext copies that Chrome may still keep in its own files, or plaintext exports you saved earlier.' : '')),
      ),
    );
  }

  function rules(): Node {
    return h(
      'p',
      { class: 'muted small', id: 'vault-rules' },
      `Use at least ${PASSPHRASE_MIN_CODE_POINTS} characters; a few unrelated words that only you would pick work well, and a long phrase is better than a short complicated one. There are no rules about capitals, digits or symbols. Your passphrase is used exactly as typed: spaces, capitals and accents all count, and nothing is trimmed. Pasting is allowed. Limit: ${PASSPHRASE_MAX_BYTES} bytes of text.`,
    );
  }

  function newPassphraseFields(): (Node | null)[] {
    invalid(newPass, 'new');
    invalid(confirmPass, 'confirm');
    return [
      h('div', { class: 'field' }, h('label', { for: 'vault-new' }, 'Passphrase'), newPass, fieldError('vault-new', 'new')),
      h('div', { class: 'field' }, h('label', { for: 'vault-confirm' }, 'Type the passphrase again'), confirmPass, fieldError('vault-confirm', 'confirm')),
      showToggle(),
      rules(),
      h(
        'div',
        { class: 'field checkbox' },
        h('input', {
          id: 'vault-ack',
          type: 'checkbox',
          checked: acknowledged,
          'aria-invalid': errors.ack ? 'true' : null,
          on: { change: (ev) => { acknowledged = (ev.target as HTMLInputElement).checked; } },
        }),
        h('label', { for: 'vault-ack' }, 'I understand that if I forget this passphrase, my records cannot be recovered except from a plaintext backup I saved myself.'),
      ),
      fieldError('vault-ack', 'ack'),
    ];
  }

  /** Validates the new-passphrase form; returns the phrase or null after showing errors. */
  function readNewPassphrase(): string | null {
    errors = {};
    const phrase = newPass.value;
    const check = checkPassphrase(phrase);
    if (!check.ok) errors.new = PASSPHRASE_PROBLEM_MESSAGE[check.problem];
    else if (confirmPass.value !== phrase) errors.confirm = 'The two passphrases are not the same. Type it again.';
    if (!acknowledged) errors.ack = 'Tick this box to confirm you understand there is no recovery.';
    if (Object.keys(errors).length > 0) {
      say('error', 'Please fix the highlighted fields. Nothing was set up.');
      host.render();
      document.querySelector<HTMLElement>('#app [aria-invalid="true"]')?.focus();
      return null;
    }
    return phrase;
  }

  async function finish(res: Awaited<ReturnType<DashboardDeps['vault']>>, okTone: Tone = 'success'): Promise<void> {
    busy = null;
    if (res.ok) {
      reset();
      host.setNotice(res.outcome === 'protected_locked' ? 'info' : okTone, res.message);
    } else if (res.error.code === 'outcome_unknown') {
      say('error', 'The extension’s reply was lost, so the result is not known yet. The current state is shown below; check it before trying again.');
    } else if (res.error.code === 'consent_required') {
      // The agreement was removed in another view; the data-practices screen replaces this form.
      host.setNotice('info', res.error.message);
    } else {
      say('error', res.error.message);
    }
    await host.reload();
    // Keep keyboard focus on the page: the form that had it is gone once unlocked.
    if (res.ok && res.outcome === 'unlocked') document.getElementById('list-heading')?.focus();
  }

  async function submitSetup(kind: 'setup' | 'migrate', replaceCandidate: boolean): Promise<void> {
    if (busy) return;
    const phrase = readNewPassphrase();
    if (phrase === null) return;
    busy = kind === 'setup' ? 'Protecting your records… Deriving a key from your passphrase takes a moment.' : 'Encrypting your existing records and checking the encrypted copy… This takes a moment.';
    feedback = null;
    // Sent once, then forgotten by this page.
    clearCredentials();
    host.announce(busy);
    host.render();
    const res = await deps.vault(kind === 'setup' ? { kind: 'setup', passphrase: phrase, acknowledged: true } : { kind: 'migrate', passphrase: phrase, acknowledged: true, replaceCandidate });
    await finish(res);
  }

  async function submitUnlock(): Promise<void> {
    if (busy) return;
    errors = {};
    const phrase = unlockPass.value;
    if (phrase === '') {
      errors.unlock = 'Enter your passphrase.';
      say('error', 'Enter your passphrase to unlock.');
      host.render();
      unlockPass.focus();
      return;
    }
    busy = 'Unlocking… Deriving a key from your passphrase takes a moment.';
    feedback = null;
    clearCredentials();
    host.announce(busy);
    host.render();
    const res = await deps.vault({ kind: 'unlock', passphrase: phrase });
    await finish(res);
    if (!res.ok) unlockPass.focus();
  }

  function invalidateBackup(): void {
    // A message about a backup describes records that may no longer exist in this state.
    if (feedbackFromBackup) {
      feedback = null;
      feedbackFromBackup = false;
    }
    if (!backupOp) return;
    backupOp = null;
    // Only this operation's own progress line is removed; a newer form or message is untouched.
    if (busy === BACKUP_BUSY) busy = null;
  }

  function sayAboutBackup(tone: Tone, text: string): void {
    say(tone, text);
    feedbackFromBackup = true;
  }

  /**
   * The explicit pre-migration plaintext backup. Every asynchronous step is
   * checked against this operation still being current (a state change in any
   * view abandons it), and the allowed state is confirmed again just before the
   * download would start, so a reply that arrives after an erase, a finished
   * migration or a Lock never starts a download of the old records. A download
   * already requested cannot be recalled.
   */
  async function downloadLegacyBackup(): Promise<void> {
    if (busy || backupOp) return;
    const op = {};
    backupOp = op;
    const current = () => backupOp === op;
    busy = BACKUP_BUSY;
    host.render();
    const res = await deps.readLegacy();
    if (!current()) return; // abandoned: discard the records unused, say nothing
    if (!res.ok) {
      backupOp = null;
      busy = null;
      sayAboutBackup('error', `The plaintext backup could not be prepared: ${res.error.message} Nothing was downloaded.`);
      host.render();
      return;
    }
    // The worker answers in order, so this read reflects at least the state the backup was read in.
    const now = await deps.read();
    if (!current()) return;
    backupOp = null;
    busy = null;
    if (!legacyBackupAvailable(now)) {
      sayAboutBackup('info', 'Your stored records changed before the download started, so no backup was downloaded. The current state is shown below.');
      host.render();
      return;
    }
    const takenAt = new Date().toISOString();
    const filename = exportFilename('backup', takenAt);
    try {
      deps.requestDownload(serializeBackup(buildBackup(res.store, takenAt)), 'application/json;charset=utf-8', filename);
    } catch (err) {
      sayAboutBackup('error', `The download could not be started (${err instanceof Error ? err.message : String(err)}). No file was created.`);
      host.render();
      return;
    }
    sayAboutBackup('info', `Download requested: ${filename}. It is an ordinary, unencrypted JSON file containing all ${res.store.cases.length === 1 ? '1 case' : `${res.store.cases.length} cases`}. Check your browser’s downloads list to confirm, and keep it somewhere safe.`);
    host.render();
  }

  async function eraseAll(): Promise<void> {
    if (busy || eraseInput.value !== ERASE_TYPED) return;
    busy = 'Erasing stored data…';
    host.render();
    const res = await deps.vault({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION });
    busy = null;
    eraseInput.value = '';
    confirmErase = false;
    if (res.ok) {
      reset();
      host.setNotice('success', res.message);
    } else if (res.error.code === 'outcome_unknown') {
      say('error', 'The extension’s reply was lost, so it is not known whether the erase finished. The current state is shown below.');
    } else {
      say('error', res.error.message);
    }
    await host.reload();
  }

  function renderErase(): Node {
    if (!confirmErase) {
      return h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'danger-outline', id: 'open-erase', on: { click: () => { confirmErase = true; host.render(); eraseInput.focus(); } } }, 'Erase stored data…'),
      );
    }
    const ready = () => eraseInput.value === ERASE_TYPED;
    const eraseBtn = h('button', { type: 'button', class: 'danger', id: 'confirm-erase', disabled: busy !== null || !ready(), on: { click: () => void eraseAll() } }, 'Permanently erase');
    eraseInput.oninput = () => {
      eraseBtn.disabled = busy !== null || !ready();
    };
    return h(
      'div',
      { class: 'confirm erase-confirm', role: 'group', 'aria-labelledby': 'erase-q', 'data-testid': 'erase-confirm' },
      h('p', { id: 'erase-q' }, 'Permanently erase all Refund Reconciler records stored in this browser profile, encrypted and plaintext? This cannot be undone. JSON backups you saved elsewhere are not affected, and you can restore one into the new empty ledger after setting a new passphrase.'),
      h('div', { class: 'field' }, h('label', { for: 'erase-typed' }, `Type ${ERASE_TYPED} to confirm`), eraseInput, h('span', { class: 'muted small', id: 'erase-hint' }, 'Capital letters, exactly as shown.')),
      eraseBtn,
      h('button', { type: 'button', on: { click: () => { confirmErase = false; eraseInput.value = ''; host.render(); document.getElementById('open-erase')?.focus(); } } }, 'Cancel'),
    );
  }

  function legacyBackupButton(state: Locked): Node | null {
    if (!legacyBackupAvailable(state)) return null;
    return h(
      'div',
      { class: 'vault-backup' },
      h('p', { class: 'muted small' }, 'Before continuing, you can download your existing records as an ordinary, unencrypted JSON backup (the same format as “Download all data”). It can be restored later into an empty, unlocked ledger.'),
      h('button', { type: 'button', id: 'legacy-backup', disabled: busy !== null, on: { click: () => void downloadLegacyBackup() } }, 'Download plaintext backup (JSON)'),
    );
  }

  function recovery(): Node {
    return h(
      'details',
      // Stays open across re-renders while the typed confirmation is shown.
      { class: 'help-more', 'data-testid': 'vault-recovery', open: confirmErase },
      h('summary', {}, 'Forgot your passphrase?'),
      h('p', {}, 'There is no recovery service and no reset link: the passphrase is never stored anywhere. If you cannot remember it, the encrypted records cannot be opened. You can erase the stored data, set a new passphrase and restore a JSON backup you saved earlier.'),
      renderErase(),
    );
  }

  function form(id: string, heading: string, onSubmit: () => void, children: (Node | null)[]): Node {
    return h(
      'form',
      { class: 'panel vault', id, 'aria-labelledby': `${id}-heading`, novalidate: true, 'data-testid': id, on: { submit: (ev) => { ev.preventDefault(); onSubmit(); } } },
      h('h2', { id: `${id}-heading`, tabindex: -1 }, heading),
      ...children,
    );
  }

  function panel(id: string, heading: string, children: (Node | null)[]): Node {
    return h('section', { class: 'panel vault problem', 'aria-labelledby': `${id}-heading`, 'data-testid': id }, h('h2', { id: `${id}-heading`, tabindex: -1 }, heading), ...children);
  }

  function submitButton(label: string): Node {
    return h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary', disabled: busy !== null }, busy ? 'Working…' : label));
  }

  function render(state: Locked): Node {
    switch (state.status) {
      case 'setup_required':
        return form('vault-setup', 'Protect your records', () => void submitSetup('setup', false), [
          state.erased ? h('p', { class: 'notice notice-info' }, 'Stored data was erased. Choose a new passphrase to start a new, empty ledger. A JSON backup can be restored after that.') : null,
          h('p', {}, 'Before you add any records, choose a passphrase to protect them.'),
          explanation(false),
          ...newPassphraseFields(),
          progress(),
          feedbackNode(),
          submitButton('Protect my records'),
        ]);
      case 'migration_required':
        return form('vault-migrate', 'Protect your existing records', () => void submitSetup('migrate', state.stage === 'candidate_unreadable'), [
          h(
            'p',
            {},
            `An earlier version of Refund Reconciler saved ${state.legacyCases === 1 ? '1 case' : `${state.legacyCases} cases`} in this browser without encryption. They are kept exactly as they are until an encrypted copy has been written and checked against them, field by field. Until then, records cannot be changed, captured or restored.`,
          ),
          state.stage === 'legacy'
            ? null
            : h('p', { class: 'notice notice-info', 'data-testid': 'migration-interrupted' }, state.stage === 'interrupted' ? 'An earlier attempt to encrypt these records did not finish. Your plaintext records are intact; you can start again.' : 'An earlier attempt left an encrypted copy that cannot be read. Your plaintext records are intact; starting again replaces that copy.'),
          legacyBackupButton(state),
          explanation(true),
          ...newPassphraseFields(),
          progress(),
          feedbackNode(),
          submitButton('Encrypt my existing records'),
          h('h3', {}, 'Recovery'),
          renderErase(),
        ]);
      case 'migration_pending':
        if (restarting) {
          return form('vault-migrate', 'Start again with a new passphrase', () => void submitSetup('migrate', true), [
            h('p', {}, 'The unchecked encrypted copy is replaced by a new one made from your intact plaintext records.'),
            legacyBackupButton(state),
            explanation(true),
            ...newPassphraseFields(),
            progress(),
            feedbackNode(),
            h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'primary', disabled: busy !== null }, 'Encrypt my existing records'), h('button', { type: 'button', on: { click: () => { restarting = false; reset(); host.render(); } } }, 'Back')),
          ]);
        }
        return form('vault-pending', 'Finish protecting your existing records', () => void submitUnlock(), [
          h('p', {}, 'An encrypted copy of your existing records was made, but it has not been checked against them yet, so the plaintext originals are still kept and records cannot be changed. Enter the passphrase you chose for it to check and finish.'),
          h('div', { class: 'field' }, h('label', { for: 'vault-unlock' }, 'Passphrase'), unlockPass, fieldError('vault-unlock', 'unlock')),
          h('p', { class: 'muted small', id: 'vault-unlock-hint' }, 'The passphrase is used exactly as typed.'),
          showToggle(),
          progress(),
          feedbackNode(),
          submitButton('Check and finish'),
          legacyBackupButton(state),
          h('p', {}, h('button', { type: 'button', class: 'link', id: 'migration-restart', on: { click: () => { reset(); restarting = true; host.render(); newPass.focus(); } } }, 'Forgot the passphrase you just chose? Start again with a new one')),
          h('h3', {}, 'Recovery'),
          renderErase(),
        ]);
      case 'locked':
        return form('vault-locked', 'Your records are locked', () => void submitUnlock(), [
          h('p', {}, 'Enter your passphrase to see and change your records. It is needed after Chrome restarts, after the extension is reloaded or updated, and after Lock now.'),
          h('div', { class: 'field' }, h('label', { for: 'vault-unlock' }, 'Passphrase'), unlockPass, fieldError('vault-unlock', 'unlock')),
          h('p', { class: 'muted small', id: 'vault-unlock-hint' }, 'The passphrase is used exactly as typed: spaces, capitals and accents all count.'),
          showToggle(),
          progress(),
          feedbackNode(),
          submitButton('Unlock'),
          recovery(),
        ]);
      case 'vault_unreadable':
        return panel('vault-unreadable', state.reason === 'unsupported' || state.reason === 'payload_unsupported' ? 'Your encrypted records use an unsupported version' : 'Your encrypted records cannot be read', [
          h('p', {}, state.reason === 'unsupported' || state.reason === 'payload_unsupported'
            ? 'They may have been written by a newer version of Refund Reconciler. This version will not change, repair or reset them.'
            : 'The stored encrypted data is damaged or incomplete. This dashboard will not repair, reset or overwrite it, and it is not treated as an empty ledger.'),
          h('pre', { class: 'detail' }, state.detail),
          h('p', { 'data-testid': 'export-unavailable' }, 'Case summaries and the JSON data export are unavailable because a valid snapshot of saved data cannot be read. Nothing is exported in place of your data.'),
          h('p', {}, 'If you have a JSON backup, you can erase the stored data, set a new passphrase and restore the backup.'),
          feedbackNode(),
          progress(),
          renderErase(),
        ]);
      case 'inconsistent':
        return panel('vault-inconsistent', 'Stored records need attention', [
          h('p', {}, 'The stored records do not agree with each other, so this version will not choose between them or change either of them.'),
          h('pre', { class: 'detail' }, state.detail),
          legacyBackupButton(state),
          feedbackNode(),
          progress(),
          renderErase(),
        ]);
      case 'storage_unavailable':
        return panel('vault-unavailable', 'Saved data can’t be used right now', [
          h('p', {}, 'Chrome could not restrict this extension’s storage to its own pages, so nothing is read, written or unlocked. Reload the extension or restart Chrome, then try again.'),
          h('pre', { class: 'detail' }, state.error),
          h('button', { type: 'button', on: { click: () => void host.reload() } }, 'Try again'),
        ]);
      default:
        // corrupt / unsupported_version / storage_error are rendered by the dashboard itself.
        return h('p', { class: 'muted' }, 'Loading saved cases…');
    }
  }

  return { render, renderErase, reset, invalidateBackup };
}
