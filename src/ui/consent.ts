// The dashboard's data-practices screen, shown whenever the service worker
// reports `consent_required`: before setup, unlock, migration, recovery
// choices, restore or capture. It explains the data practices (from the shared
// definition in src/consent/practices.ts) and asks for an explicit
// Agree and continue. Not now changes nothing. Opening the dashboard, reading
// this screen, using links or ticking boxes elsewhere is never agreement.
//
// The screen never advances on the worker's reply alone: after Agree and
// continue it re-reads the state, so an agreement overtaken by an erase or a
// newer change in another view never shows the next screen.

import { DATA_PRACTICES, DATA_PRACTICES_VERSION } from '../consent/practices';
import type { LedgerState } from '../vault/state';
import type { DashboardDeps } from './deps';
import { h } from './dom';
import { practicesVersionNote, renderPracticeSections } from './practices';

type Tone = 'success' | 'error' | 'info';
type ConsentState = Extract<LedgerState, { status: 'consent_required' }>;

export interface ConsentHost {
  deps: DashboardDeps;
  render: () => void;
  announce: (text: string) => void;
  setNotice: (tone: Tone, text: string) => void;
  /** Re-reads the state until the latest read has been applied, then re-renders. False if no fresh read was applied. */
  settle: () => Promise<boolean>;
  /** The status the dashboard currently shows. */
  status: () => string;
  /** The typed Erase stored data… control (available without agreeing). */
  renderErase: () => Node;
}

export interface ConsentScreen {
  render(state: ConsentState): Node;
  /** Back to the disclosure with no message (when the state changes underneath). */
  reset(): void;
}

/**
 * States the service worker reports only after the consent gate passed: the
 * agreement is current. Anything else (storage_error, storage_unavailable, or
 * a transitional page state) does not confirm it.
 */
const PASSED_GATE: ReadonlySet<string> = new Set<Exclude<LedgerState['status'], 'consent_required' | 'storage_error' | 'storage_unavailable'>>([
  'ok',
  'setup_required',
  'migration_required',
  'migration_pending',
  'locked',
  'vault_unreadable',
  'inconsistent',
  'corrupt',
  'unsupported_version',
]);

const REASON_TEXT: Record<ConsentState['reason'], string | null> = {
  missing: null,
  obsolete: 'The data practices changed since you last agreed, so please review them and agree again to continue. Your stored records are unchanged.',
  invalid: 'The stored record of your agreement is damaged, so it is not treated as agreement. Please review the data practices and agree again to continue. Your stored records are unchanged.',
};

export function createConsentScreen(host: ConsentHost): ConsentScreen {
  const { deps } = host;
  let phase: 'disclosure' | 'deferred' = 'disclosure';
  let busy = false;
  let feedback: { tone: Tone; text: string } | null = null;
  /** Identifies the agreement in flight; reset() abandons it so its reply cannot speak for a newer state. */
  let op: object | null = null;

  function reset(): void {
    phase = 'disclosure';
    feedback = null;
    op = null;
    busy = false;
  }

  function say(tone: Tone, text: string): void {
    feedback = { tone, text };
    host.announce(text);
  }

  function focus(id: string): void {
    document.getElementById(id)?.focus();
  }

  async function accept(): Promise<void> {
    if (busy) return;
    const mine = {};
    op = mine;
    busy = true;
    feedback = null;
    host.announce('Saving your agreement…');
    host.render();
    const res = await deps.acceptDataPractices(DATA_PRACTICES_VERSION);
    if (op !== mine) return; // abandoned by a state change; the fresh state decides what is shown
    busy = false;
    if (!res.ok && res.error.code !== 'outcome_unknown') {
      op = null;
      say('error', `${res.error.message} You can try again.`);
      host.render();
      focus('consent-agree');
      return;
    }
    // Advance only from a fresh read of the current state, never from the reply.
    const fresh = await host.settle();
    if (op !== mine) return;
    op = null;
    const now = host.status();
    if (fresh && now === 'consent_required') {
      say(
        res.ok ? 'info' : 'error',
        res.ok
          ? 'Your agreement was stored, but it is no longer current: stored data changed in another view (for example it was erased). Please review the data practices again.'
          : 'Your agreement could not be confirmed and is not recorded now. Nothing else changed. Choose Agree and continue to try again.',
      );
      host.render();
      focus('consent-heading');
      return;
    }
    if (!fresh || !PASSED_GATE.has(now)) {
      // No fresh state that shows the gate passed (for example storage could not be
      // read or restricted): never claim the agreement is confirmed, and never
      // claim it was rejected either. Data features stay unavailable.
      host.setNotice(
        'error',
        res.ok
          ? 'Your agreement was stored, but this browser’s extension storage can’t be checked right now, so data features stay unavailable. Try again later.'
          : 'The extension’s reply was lost and its storage can’t be checked right now, so it is not confirmed whether your agreement was stored. Data features stay unavailable; try again later.',
      );
      host.render();
      return;
    }
    host.setNotice('success', res.ok ? res.message : 'Your agreement is stored in this browser profile. (The extension’s reply was lost, but the current state confirms it.)');
    host.render();
    document.querySelector<HTMLElement>('#app h2[tabindex="-1"]')?.focus();
  }

  function eraseSection(): Node {
    return h(
      'section',
      { class: 'consent-erase', 'aria-labelledby': 'consent-erase-heading', 'data-testid': 'consent-erase' },
      h('h3', { id: 'consent-erase-heading' }, 'Remove stored data instead'),
      h(
        'p',
        { class: 'muted small' },
        'You do not have to agree in order to remove what this extension stored in this browser profile, for example after a forgotten passphrase or damaged records. Erasing deletes every stored record, encrypted or not, without reading it, and cannot be undone. Backups you saved elsewhere are not affected.',
      ),
      host.renderErase(),
    );
  }

  function feedbackNode(): Node | null {
    return feedback ? h('p', { class: `notice notice-${feedback.tone}`, role: feedback.tone === 'error' ? 'alert' : null, 'data-testid': 'consent-feedback' }, feedback.text) : null;
  }

  function renderDeferred(): Node {
    return h(
      'section',
      { class: 'panel consent', 'aria-labelledby': 'consent-deferred-heading', 'data-testid': 'consent-deferred' },
      h('h2', { id: 'consent-deferred-heading', tabindex: -1 }, 'Data features are unavailable'),
      h(
        'p',
        {},
        'You have not agreed to the data practices, so Refund Reconciler will not show or change records, set up or ask for a passphrase, restore a backup or read anything from web pages. Any records already stored in this browser profile are kept unchanged.',
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'primary', id: 'consent-review', on: { click: () => { phase = 'disclosure'; feedback = null; host.render(); focus('consent-heading'); } } }, 'Review data practices'),
      ),
      eraseSection(),
    );
  }

  function render(state: ConsentState): Node {
    if (phase === 'deferred') return renderDeferred();
    const reason = REASON_TEXT[state.reason];
    return h(
      'section',
      { class: 'panel consent', 'aria-labelledby': 'consent-heading', 'data-testid': 'consent-gate', 'data-reason': state.reason },
      h('h2', { id: 'consent-heading', tabindex: -1 }, DATA_PRACTICES.heading),
      reason ? h('p', { class: 'notice notice-info', 'data-testid': 'consent-reason' }, reason) : null,
      h('p', {}, DATA_PRACTICES.intro),
      ...renderPracticeSections('h3', 'consent'),
      practicesVersionNote(),
      feedbackNode(),
      h(
        'div',
        { class: 'actions consent-actions' },
        h('button', { type: 'button', class: 'primary', id: 'consent-agree', disabled: busy, on: { click: () => void accept() } }, busy ? 'Saving your agreement…' : 'Agree and continue'),
        h(
          'button',
          {
            type: 'button',
            id: 'consent-defer',
            disabled: busy,
            on: { click: () => { phase = 'deferred'; feedback = null; host.announce('Not agreed. Data features stay unavailable; nothing was changed.'); host.render(); focus('consent-deferred-heading'); } },
          },
          'Not now',
        ),
      ),
      eraseSection(),
    );
  }

  return { render, reset };
}
