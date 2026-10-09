// Dashboard presentation. Reads validated data from storage, renders it, and
// sends every change to the service worker. It never computes money itself:
// all figures come from the pure domain functions.

import { centsToInput, formatUsd, moneyErrorMessage, parseMoney } from '../domain/money';
import { buildTimeline, summarizeCase, type CaseSummary, type ItemSummary, type TimelineRow } from '../domain/reconcile';
import type { CaseRecord, Command, RecordEntryCommand, StoreData } from '../domain/types';
import { LIMITS, isValidCalendarDate } from '../domain/validate';
import { ERASE_CONFIRMATION, isResponse, type Request, type Response } from '../background/messages';
import { STORE_KEY, loadStore, type LoadResult, type StorageAreaLike } from '../persistence/storage';
import { h, replaceContent } from './dom';
import {
  CASE_STATUS_LABEL,
  FLAG_LABEL,
  ITEM_STATUS_LABEL,
  KIND_LABEL,
  REVIEW_REASON_LABEL,
  REVIEW_REASON_SHORT,
  formatTimestamp,
  moneyOrUnknown,
} from './labels';

type EvidenceKind = 'merchant_report' | 'receipt' | 'recharge';

interface ItemDraft {
  key: string;
  label: string;
  amount: string;
  unknown: boolean;
}

interface CreateDraft {
  caseId: string;
  orderRef: string;
  items: ItemDraft[];
  errors: Record<string, string>;
}

interface EntryDraft {
  id: string;
  itemId: string;
  kind: EvidenceKind | 'expectation';
  amount: string;
  unknown: boolean;
  occurredOn: string;
  source: string;
  reference: string;
  note: string;
  errors: Record<string, string>;
}

interface VoidDraft {
  id: string;
  targetEntryId: string;
  reason: string;
  error: string;
}

type View = { name: 'list' } | { name: 'create'; draft: CreateDraft } | { name: 'case'; caseId: string };

interface State {
  load: LoadResult | { status: 'loading' };
  view: View;
  entryDraft: EntryDraft | null;
  voidDraft: VoidDraft | null;
  confirmDelete: boolean;
  confirmErase: boolean;
  busy: boolean;
  notice: { tone: 'success' | 'error' | 'info'; text: string } | null;
}

const DEFAULT_SOURCE: Record<EntryDraft['kind'], string> = {
  expectation: 'Manual entry',
  merchant_report: 'Merchant order page (entered manually)',
  receipt: 'Manual confirmation',
  recharge: 'Manual entry',
};

export interface AppDeps {
  area: StorageAreaLike;
  send: (req: Request) => Promise<Response>;
  newId: () => string;
  subscribe: (onChange: () => void) => void;
}

export function chromeDeps(): AppDeps {
  return {
    area: {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
      remove: (key) => chrome.storage.local.remove(key),
    },
    async send(req) {
      try {
        const res: unknown = await chrome.runtime.sendMessage(req);
        if (isResponse(res)) return res;
        return { ok: false, error: { code: 'outcome_unknown', message: 'The extension did not return a valid response.' } };
      } catch (err) {
        // The request may have reached the service worker and been saved before
        // the reply was lost, so this is an unknown outcome, not a failure.
        return { ok: false, error: { code: 'outcome_unknown', message: err instanceof Error ? err.message : String(err) } };
      }
    },
    newId: () => crypto.randomUUID(),
    subscribe(onChange) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && STORE_KEY in changes) onChange();
      });
    },
  };
}

export function startApp(root: HTMLElement, statusRegion: HTMLElement, deps: AppDeps): void {
  const state: State = {
    load: { status: 'loading' },
    view: { name: 'list' },
    entryDraft: null,
    voidDraft: null,
    confirmDelete: false,
    confirmErase: false,
    busy: false,
    notice: null,
  };

  let loadSeq = 0;
  let deletingCaseId: string | null = null;
  /** Operation id whose save could not be confirmed; resolved by re-reading storage. */
  let uncertainOpId: string | null = null;
  async function reload(): Promise<void> {
    const seq = ++loadSeq;
    const result = await loadStore(deps.area);
    if (seq !== loadSeq) return; // a newer load superseded this one
    state.load = result;
    if (state.view.name === 'case' && result.status === 'ok') {
      const caseId = state.view.caseId;
      if (!result.store.cases.some((c) => c.id === caseId)) {
        state.view = { name: 'list' };
        state.entryDraft = null;
        state.voidDraft = null;
        if (caseId !== deletingCaseId) state.notice = { tone: 'info', text: 'That case was deleted in another view.' };
      }
    }
    if (result.status === 'ok') closeCommittedDrafts(result.store);
    render();
  }

  function storeHasId(data: StoreData, id: string): boolean {
    return data.cases.some((c) => c.id === id || c.entries.some((e) => e.id === id));
  }

  /**
   * A form's draft carries the id its submission uses. If that id is already in
   * saved data, the change was committed (perhaps by a submission whose reply
   * was lost), so the form must not be offered for re-entry.
   */
  function closeCommittedDrafts(data: StoreData): void {
    const entryIds = new Set(data.cases.flatMap((c) => c.entries.map((e) => e.id)));
    let committedId: string | null = null;
    if (state.entryDraft && entryIds.has(state.entryDraft.id)) {
      committedId = state.entryDraft.id;
      state.entryDraft = null;
    }
    if (state.voidDraft && entryIds.has(state.voidDraft.id)) {
      committedId = state.voidDraft.id;
      state.voidDraft = null;
    }
    const view = state.view;
    if (view.name === 'create' && data.cases.some((c) => c.id === view.draft.caseId)) {
      committedId = view.draft.caseId;
      state.view = { name: 'case', caseId: committedId };
    }
    if (committedId !== null && committedId === uncertainOpId) {
      // A change whose reply was lost has since appeared in saved data.
      uncertainOpId = null;
      setNotice('success', 'Saved. The extension’s reply was lost, but the change is now in your saved data, so it was not recorded twice.');
    }
  }

  function setNotice(tone: 'success' | 'error' | 'info', text: string): void {
    state.notice = { tone, text };
    statusRegion.textContent = text;
  }

  /**
   * Sends one change and reports what is actually known about it.
   * `opId` is the id the change writes (entry, void or case id). It is reused
   * unchanged on retry, so a retry after an uncertain outcome is idempotent.
   */
  async function run(req: Request, successText: string, opId?: string): Promise<boolean> {
    // A new submission gets its own answer; stop watching for an earlier lost reply.
    uncertainOpId = null;
    state.busy = true;
    render();
    const res = await deps.send(req);
    state.busy = false;
    if (!res.ok && res.error.code === 'outcome_unknown') {
      // Never treat a lost reply as a failure: read storage directly and look
      // for the operation's own id.
      uncertainOpId = opId ?? null;
      const check = await loadStore(deps.area);
      if (!opId) {
        setNotice('error', 'Could not confirm whether this change was saved. The page now shows what is in saved data; check it before trying again.');
      } else if (check.status === 'ok' && storeHasId(check.store, opId)) {
        uncertainOpId = null;
        setNotice('success', 'Saved. The extension’s reply was lost, but the change is in your saved data, so it was not recorded twice.');
      } else if (check.status === 'ok') {
        setNotice(
          'error',
          'Could not confirm this change: it is not in your saved data right now. Your input is kept. Submitting again is safe because it reuses the same entry ID, so it cannot be recorded twice.',
        );
      } else {
        setNotice(
          'error',
          'Could not confirm whether this change was saved, and saved data could not be re-read. Your input is kept. Submitting again is safe because it reuses the same entry ID, so it cannot be recorded twice.',
        );
      }
      await reload();
      return false;
    }
    if (res.ok) {
      setNotice(
        'success',
        res.outcome === 'duplicate'
          ? 'Already recorded — nothing was added twice.'
          : res.outcome === 'unchanged'
            ? 'No change needed.'
            : successText,
      );
    } else if (res.error.code === 'write_rejected') {
      setNotice('error', `${res.error.message} Your input is kept so you can try again.`);
    } else {
      setNotice('error', res.error.message);
    }
    await reload();
    return res.ok;
  }

  // ---- Actions ----

  function openCreate(): void {
    state.view = {
      name: 'create',
      draft: { caseId: deps.newId(), orderRef: '', items: [{ key: deps.newId(), label: '', amount: '', unknown: false }], errors: {} },
    };
    state.notice = null;
    render();
    document.getElementById('order-ref')?.focus();
  }

  function openCase(caseId: string, keepNotice = false): void {
    state.view = { name: 'case', caseId };
    state.entryDraft = null;
    state.voidDraft = null;
    state.confirmDelete = false;
    if (!keepNotice) state.notice = null;
    render();
    document.getElementById('case-heading')?.focus();
  }

  function backToList(): void {
    state.view = { name: 'list' };
    state.entryDraft = null;
    state.voidDraft = null;
    state.confirmDelete = false;
    render();
    document.getElementById('list-heading')?.focus();
  }

  async function submitCreate(draft: CreateDraft): Promise<void> {
    const errors: Record<string, string> = {};
    const items: { itemId: string; label: string; expectedCents: number | null; expectationEntryId: string }[] = [];
    if (draft.orderRef.length > LIMITS.orderRefMax) errors['order-ref'] = `At most ${LIMITS.orderRefMax} characters.`;
    draft.items.forEach((item, i) => {
      if (item.label.trim() === '') errors[`item-label-${i}`] = 'Describe the item.';
      else if (item.label.length > LIMITS.labelMax) errors[`item-label-${i}`] = `At most ${LIMITS.labelMax} characters.`;
      let expectedCents: number | null = null;
      if (!item.unknown) {
        const parsed = parseMoney(item.amount);
        if (parsed.ok) expectedCents = parsed.cents;
        else errors[`item-amount-${i}`] = `${moneyErrorMessage(parsed.error)} Or tick “Unknown”.`;
      }
      items.push({ itemId: `item-${item.key}`, label: item.label.trim(), expectedCents, expectationEntryId: `exp-${item.key}` });
    });
    draft.errors = errors;
    if (Object.keys(errors).length > 0) {
      setNotice('error', 'Please fix the highlighted fields. Nothing was saved.');
      render();
      focusFirstError();
      return;
    }
    const ok = await run(
      { kind: 'mutate', command: { type: 'createCase', caseId: draft.caseId, orderRef: draft.orderRef.trim() || null, items } },
      'Case saved.',
      draft.caseId,
    );
    if (ok) openCase(draft.caseId, true);
  }

  function openEntry(itemSummary: ItemSummary, kind: EntryDraft['kind']): void {
    state.entryDraft = {
      id: deps.newId(),
      itemId: itemSummary.item.id,
      kind,
      amount: kind === 'expectation' && itemSummary.expectedCents !== null ? centsToInput(itemSummary.expectedCents) : '',
      unknown: kind === 'expectation' && itemSummary.expectedCents === null,
      occurredOn: '',
      source: DEFAULT_SOURCE[kind],
      reference: '',
      note: '',
      errors: {},
    };
    state.voidDraft = null;
    state.notice = null;
    render();
    document.getElementById(kind === 'expectation' && state.entryDraft.unknown ? 'entry-unknown' : 'entry-amount')?.focus();
  }

  async function submitEntry(caseRecord: CaseRecord, draft: EntryDraft): Promise<void> {
    const errors: Record<string, string> = {};
    let amountCents: number | null = null;
    if (!(draft.kind === 'expectation' && draft.unknown)) {
      const parsed = parseMoney(draft.amount);
      if (!parsed.ok) errors['entry-amount'] = moneyErrorMessage(parsed.error);
      else if (parsed.cents === 0 && (draft.kind === 'receipt' || draft.kind === 'recharge')) {
        errors['entry-amount'] = 'Amount must be greater than zero.';
      } else amountCents = parsed.cents;
    }
    if (draft.occurredOn !== '' && !isValidCalendarDate(draft.occurredOn)) errors['entry-date'] = 'Use a valid date.';
    if (draft.source.trim() === '') errors['entry-source'] = 'Say where this came from.';
    else if (draft.source.length > LIMITS.sourceMax) errors['entry-source'] = `At most ${LIMITS.sourceMax} characters.`;
    if (draft.reference.length > LIMITS.referenceMax) errors['entry-reference'] = `At most ${LIMITS.referenceMax} characters.`;
    if (draft.note.length > LIMITS.noteMax) errors['entry-note'] = `At most ${LIMITS.noteMax} characters.`;
    draft.errors = errors;
    if (Object.keys(errors).length > 0) {
      setNotice('error', 'Please fix the highlighted fields. Nothing was saved.');
      render();
      focusFirstError();
      return;
    }
    const entry: RecordEntryCommand['entry'] = {
      id: draft.id,
      kind: draft.kind,
      itemId: draft.itemId,
      amountCents,
      occurredOn: draft.occurredOn === '' ? null : draft.occurredOn,
      source: draft.source.trim(),
      note: draft.note.trim(),
      reference: draft.kind === 'expectation' || draft.reference.trim() === '' ? null : draft.reference.trim(),
    };
    const command: Command = { type: 'recordEntry', caseId: caseRecord.id, entry };
    const ok = await run({ kind: 'mutate', command }, draft.kind === 'expectation' ? 'Expected amount saved.' : 'Entry saved.', draft.id);
    if (ok) {
      state.entryDraft = null;
      render();
      document.getElementById('case-heading')?.focus();
    }
  }

  async function submitVoid(caseRecord: CaseRecord, draft: VoidDraft): Promise<void> {
    if (draft.reason.trim() === '') {
      draft.error = 'Give a reason so the audit trail explains the void.';
      render();
      document.getElementById('void-reason')?.focus();
      return;
    }
    const ok = await run(
      { kind: 'mutate', command: { type: 'voidEntry', caseId: caseRecord.id, voidEntryId: draft.id, targetEntryId: draft.targetEntryId, reason: draft.reason.trim() } },
      'Entry voided. The original stays in the timeline.',
      draft.id,
    );
    if (ok) {
      state.voidDraft = null;
      render();
    }
  }

  function focusFirstError(): void {
    const el = root.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
  }

  // ---- Rendering ----

  function render(): void {
    const children: (Node | null)[] = [];
    if (state.notice) {
      children.push(
        h('p', { class: `notice notice-${state.notice.tone}`, role: state.notice.tone === 'error' ? 'alert' : null, 'data-testid': 'notice' }, state.notice.text),
      );
    }
    children.push(renderBody());
    replaceContent(root, children);
  }

  function renderBody(): Node {
    const load = state.load;
    switch (load.status) {
      case 'loading':
        return h('p', { class: 'muted' }, 'Loading saved cases…');
      case 'storage_error':
        return h(
          'section',
          { class: 'panel problem', 'data-testid': 'storage-error' },
          h('h2', {}, 'Storage could not be read'),
          h('p', {}, 'Chrome reported an error while reading extension storage. Nothing has been changed.'),
          h('pre', { class: 'detail' }, load.error),
          h('button', { type: 'button', on: { click: () => void reload() } }, 'Try again'),
        );
      case 'corrupt':
      case 'unsupported_version':
        return renderUnreadable(load);
      case 'ok':
        break;
    }
    const view = state.view;
    if (view.name === 'create') return renderCreate(view.draft);
    if (view.name === 'case') {
      const c = load.store.cases.find((x) => x.id === view.caseId);
      if (c) return renderCase(c);
    }
    return renderList(load.store);
  }

  function renderUnreadable(load: Extract<LoadResult, { status: 'corrupt' | 'unsupported_version' }>): Node {
    const title =
      load.status === 'unsupported_version' ? 'Stored data uses an unsupported version' : 'Stored data could not be read';
    const detail =
      load.status === 'unsupported_version'
        ? `Found schema version ${JSON.stringify(load.version) ?? 'missing'}; this build understands version 1. It may have been written by a newer build.`
        : load.error;
    let raw: string;
    try {
      raw = JSON.stringify(load.raw, null, 2) ?? String(load.raw);
    } catch {
      raw = String(load.raw);
    }
    return h(
      'section',
      { class: 'panel problem', 'data-testid': 'unreadable' },
      h('h2', {}, title),
      h('p', {}, 'Nothing has been changed, reset or deleted, and new changes are blocked until this is resolved.'),
      h('pre', { class: 'detail' }, detail),
      h('label', { for: 'raw-data' }, 'Raw stored data (read-only — copy it if you need to keep it)'),
      h('textarea', { id: 'raw-data', readonly: true, rows: 8, value: raw }),
      state.confirmErase
        ? h(
            'div',
            { class: 'confirm', role: 'group', 'aria-labelledby': 'erase-q' },
            h('p', { id: 'erase-q' }, 'Permanently erase all Refund Reconciler data stored in this browser profile? This cannot be undone.'),
            h('button', { type: 'button', class: 'danger', disabled: state.busy, on: { click: () => void eraseAll() } }, 'Permanently erase'),
            h('button', { type: 'button', on: { click: () => { state.confirmErase = false; render(); } } }, 'Cancel'),
          )
        : h('button', { type: 'button', class: 'danger-outline', on: { click: () => { state.confirmErase = true; render(); } } }, 'Erase stored data…'),
    );
  }

  async function eraseAll(): Promise<void> {
    const ok = await run({ kind: 'eraseAll', confirm: ERASE_CONFIRMATION }, 'Stored data erased.');
    if (ok) {
      state.confirmErase = false;
      state.view = { name: 'list' };
      render();
    }
  }

  function caseTitle(c: CaseRecord): string {
    return c.orderRef ? `Order ${c.orderRef}` : `Case with ${c.items.length} item${c.items.length === 1 ? '' : 's'}`;
  }

  function caseRow(c: CaseRecord): Node {
    const s = summarizeCase(c);
    return h(
      'li',
      { class: 'case-row' },
      h(
        'button',
        { type: 'button', class: 'case-link', 'data-testid': 'case-row', on: { click: () => openCase(c.id) } },
        h('span', { class: 'case-title' }, c.isDemo ? h('span', { class: 'badge badge-demo' }, 'Synthetic') : null, ' ', caseTitle(c)),
        h('span', { class: 'case-items' }, c.items.map((i) => i.label).join(' · ')),
        h('span', { class: `badge status-${s.status}` }, CASE_STATUS_LABEL[s.status]),
        h(
          'span',
          { class: 'case-amount' },
          `Unresolved ${formatUsd(s.unresolvedCents)}`,
          s.unknownExpectationCount > 0 ? ` · ${s.unknownExpectationCount} unknown` : '',
        ),
        reviewCount(s) > 0
          ? h('span', { class: 'case-review', 'data-testid': 'case-row-review' }, `${reviewCount(s)} item${reviewCount(s) === 1 ? '' : 's'} to review: ${reviewSummary(s)}`)
          : null,
      ),
    );
  }

  function renderList(data: StoreData): Node {
    const real = data.cases.filter((c) => !c.isDemo);
    const demo = data.cases.filter((c) => c.isDemo);
    return h(
      'div',
      {},
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'list-heading' },
        h(
          'div',
          { class: 'row-between' },
          h('h2', { id: 'list-heading', tabindex: -1 }, 'Your cases'),
          h('button', { type: 'button', class: 'primary', on: { click: openCreate } }, 'Create case'),
        ),
        real.length === 0
          ? h(
              'div',
              { class: 'empty', 'data-testid': 'empty-state' },
              h('p', {}, 'No cases yet.'),
              h(
                'p',
                { class: 'muted' },
                'Refund Reconciler only knows what you enter here. Nothing is captured from Amazon or your bank automatically, so an empty list says nothing about your refunds.',
              ),
            )
          : h('ul', { class: 'case-list', 'data-testid': 'real-cases' }, ...real.map(caseRow)),
      ),
      h(
        'section',
        { class: 'panel demo-panel', 'aria-labelledby': 'demo-heading' },
        h('h2', { id: 'demo-heading' }, 'Synthetic demo'),
        h('p', { class: 'muted' }, 'Made-up example cases to explore the dashboard. They are not real orders and are kept separate from your cases.'),
        demo.length === 0
          ? h('button', { type: 'button', disabled: state.busy, on: { click: () => void run({ kind: 'mutate', command: { type: 'loadDemo' } }, 'Synthetic demo loaded.') } }, 'Load synthetic demo')
          : h(
              'div',
              {},
              h('ul', { class: 'case-list', 'data-testid': 'demo-cases' }, ...demo.map(caseRow)),
              h('button', { type: 'button', disabled: state.busy, on: { click: () => void run({ kind: 'mutate', command: { type: 'removeDemo' } }, 'Synthetic demo removed.') } }, 'Remove synthetic demo'),
            ),
      ),
    );
  }

  function fieldError(id: string, errors: Record<string, string>): Node | null {
    const msg = errors[id];
    return msg ? h('span', { class: 'field-error', id: `${id}-error` }, msg) : null;
  }

  function invalidAttrs(id: string, errors: Record<string, string>): Record<string, string | null> {
    return errors[id] ? { 'aria-invalid': 'true', 'aria-describedby': `${id}-error` } : { 'aria-invalid': null, 'aria-describedby': null };
  }

  function renderCreate(draft: CreateDraft): Node {
    const e = draft.errors;
    const form = h(
      'form',
      {
        class: 'panel',
        'aria-labelledby': 'create-heading',
        novalidate: true,
        on: {
          submit: (ev) => {
            ev.preventDefault();
            void submitCreate(draft);
          },
        },
      },
      h('h2', { id: 'create-heading' }, 'Create case'),
      h('p', { class: 'muted' }, 'Amazon US · USD. Enter the refund you expect for each returned item, or mark it unknown.'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'order-ref' }, 'Order reference (optional)'),
        h('input', { id: 'order-ref', type: 'text', maxlength: LIMITS.orderRefMax, autocomplete: 'off', value: draft.orderRef, ...invalidAttrs('order-ref', e), on: { input: (ev) => { draft.orderRef = (ev.target as HTMLInputElement).value; } } }),
        fieldError('order-ref', e),
      ),
      h(
        'fieldset',
        {},
        h('legend', {}, 'Items'),
        ...draft.items.map((item, i) =>
          h(
            'div',
            { class: 'item-draft', 'data-testid': 'item-draft' },
            h(
              'div',
              { class: 'field grow' },
              h('label', { for: `item-label-${i}` }, `Item ${i + 1} description`),
              h('input', { id: `item-label-${i}`, type: 'text', maxlength: LIMITS.labelMax, autocomplete: 'off', value: item.label, ...invalidAttrs(`item-label-${i}`, e), on: { input: (ev) => { item.label = (ev.target as HTMLInputElement).value; } } }),
              fieldError(`item-label-${i}`, e),
            ),
            h(
              'div',
              { class: 'field' },
              h('label', { for: `item-amount-${i}` }, `Item ${i + 1} expected refund (USD)`),
              h('input', { id: `item-amount-${i}`, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: item.amount, disabled: item.unknown, ...invalidAttrs(`item-amount-${i}`, e), on: { input: (ev) => { item.amount = (ev.target as HTMLInputElement).value; } } }),
              fieldError(`item-amount-${i}`, e),
            ),
            h(
              'div',
              { class: 'field checkbox' },
              h('input', { id: `item-unknown-${i}`, type: 'checkbox', checked: item.unknown, on: { change: (ev) => { item.unknown = (ev.target as HTMLInputElement).checked; e[`item-amount-${i}`] = ''; render(); } } }),
              h('label', { for: `item-unknown-${i}` }, 'Unknown'),
            ),
            draft.items.length > 1
              ? h('button', { type: 'button', class: 'link', 'aria-label': `Remove item ${i + 1}`, on: { click: () => { draft.items.splice(i, 1); draft.errors = {}; render(); } } }, 'Remove')
              : null,
          ),
        ),
        draft.items.length < LIMITS.itemsPerCase
          ? h('button', { type: 'button', on: { click: () => { draft.items.push({ key: deps.newId(), label: '', amount: '', unknown: false }); render(); document.getElementById(`item-label-${draft.items.length - 1}`)?.focus(); } } }, 'Add another item')
          : null,
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'submit', class: 'primary', disabled: state.busy }, state.busy ? 'Saving…' : 'Save case'),
        h('button', { type: 'button', on: { click: backToList } }, 'Cancel'),
      ),
    );
    return form;
  }

  function reviewCount(s: CaseSummary): number {
    return s.items.filter((i) => i.reviewReasons.length > 0).length;
  }

  function reviewSummary(s: CaseSummary): string {
    const reasons = new Set(s.items.flatMap((i) => i.reviewReasons));
    return [...reasons].map((r) => REVIEW_REASON_SHORT[r]).join('; ');
  }

  function renderSummary(s: CaseSummary): Node {
    return h(
      'dl',
      { class: 'summary', 'data-testid': 'case-summary' },
      h('div', {}, h('dt', {}, 'Case status'), h('dd', { 'data-testid': 'case-status' }, h('span', { class: `badge status-${s.status}` }, CASE_STATUS_LABEL[s.status]))),
      h('div', {}, h('dt', {}, 'Unresolved expected amount'), h('dd', { 'data-testid': 'case-unresolved' }, formatUsd(s.unresolvedCents))),
      h('div', {}, h('dt', {}, 'Confirmed net received'), h('dd', { 'data-testid': 'case-net' }, formatUsd(s.netConfirmedCents))),
      h('div', {}, h('dt', {}, 'Known expected total'), h('dd', {}, formatUsd(s.knownExpectedCents), s.unknownExpectationCount > 0 ? ` + ${s.unknownExpectationCount} unknown` : '')),
      s.excessCents > 0 ? h('div', {}, h('dt', {}, 'Excess for review'), h('dd', { 'data-testid': 'case-excess' }, formatUsd(s.excessCents))) : null,
    );
  }

  function renderCase(c: CaseRecord): Node {
    const s = summarizeCase(c);
    return h(
      'div',
      {},
      h('button', { type: 'button', class: 'link back', on: { click: backToList } }, '← All cases'),
      h(
        'section',
        { class: 'panel', 'aria-labelledby': 'case-heading' },
        h('h2', { id: 'case-heading', tabindex: -1 }, c.isDemo ? h('span', { class: 'badge badge-demo' }, 'Synthetic demo') : null, ' ', caseTitle(c)),
        h('p', { class: 'muted' }, `Amazon US · ${c.currency} · created ${formatTimestamp(c.createdAt)}`),
        renderSummary(s),
        reviewCount(s) > 0
          ? h(
              'div',
              { class: 'review', 'data-testid': 'case-review' },
              h('h3', {}, 'Why this case needs review'),
              h(
                'ul',
                {},
                ...s.items.flatMap((it) => it.reviewReasons.map((r) => h('li', {}, `${it.item.label}: ${REVIEW_REASON_LABEL[r]}`))),
              ),
            )
          : null,
        h(
          'p',
          { class: 'muted small' },
          'The unresolved amount is what you expected but have not confirmed receiving. It is a prompt to review your records, not a guarantee that money is owed.',
        ),
      ),
      h('section', { class: 'panel', 'aria-labelledby': 'items-heading' }, h('h2', { id: 'items-heading' }, 'Items'), h('ul', { class: 'items' }, ...s.items.map((it) => renderItem(c, it)))),
      renderTimeline(c),
      renderDelete(c),
    );
  }

  function renderItem(c: CaseRecord, it: ItemSummary): Node {
    const draft = state.entryDraft?.itemId === it.item.id ? state.entryDraft : null;
    const label = it.item.label;
    // Flags already explained as review reasons are not repeated.
    const infoFlags = it.flags.filter((f) => !(it.reviewReasons as readonly string[]).includes(f));
    return h(
      'li',
      { class: 'item', 'data-testid': 'item', 'data-item-id': it.item.id },
      h(
        'div',
        { class: 'row-between' },
        h('h3', { class: 'item-label' }, label),
        h(
          'span',
          { class: 'badges' },
          h('span', { class: `badge item-${it.status}`, 'data-testid': 'item-status' }, ITEM_STATUS_LABEL[it.status]),
          it.reviewReasons.length > 0 ? h('span', { class: 'badge status-needs_review', 'data-testid': 'item-needs-review' }, 'Needs review') : null,
        ),
      ),
      h(
        'dl',
        { class: 'figures' },
        h('div', {}, h('dt', {}, 'Expected'), h('dd', { 'data-testid': 'item-expected' }, moneyOrUnknown(it.expectedCents))),
        h('div', {}, h('dt', {}, 'Merchant reports issued'), h('dd', { 'data-testid': 'item-reported' }, it.merchantReportedCents === null ? 'No report' : formatUsd(it.merchantReportedCents))),
        h('div', {}, h('dt', {}, 'Confirmed received'), h('dd', {}, formatUsd(it.confirmedReceivedCents))),
        h('div', {}, h('dt', {}, 'Recharged'), h('dd', {}, formatUsd(it.rechargedCents))),
        h('div', {}, h('dt', {}, 'Confirmed net'), h('dd', { 'data-testid': 'item-net' }, formatUsd(it.netConfirmedCents))),
        h(
          'div',
          {},
          h('dt', {}, it.excessCents ? 'Excess' : 'Difference'),
          h('dd', { 'data-testid': 'item-difference' }, it.differenceCents === null ? 'Unknown' : it.excessCents ? `${formatUsd(it.excessCents)} more than expected` : formatUsd(it.differenceCents)),
        ),
      ),
      it.reviewReasons.length > 0
        ? h('ul', { class: 'review-reasons', 'data-testid': 'item-review-reasons' }, ...it.reviewReasons.map((r) => h('li', {}, REVIEW_REASON_LABEL[r])))
        : null,
      infoFlags.length > 0 ? h('ul', { class: 'flags' }, ...infoFlags.map((f) => h('li', {}, FLAG_LABEL[f]))) : null,
      draft
        ? renderEntryForm(c, it, draft)
        : h(
            'div',
            { class: 'item-actions', role: 'group', 'aria-label': `Actions for ${label}` },
            h('button', { type: 'button', on: { click: () => openEntry(it, 'merchant_report') } }, 'Record merchant report'),
            h('button', { type: 'button', on: { click: () => openEntry(it, 'receipt') } }, 'Confirm money received'),
            h('button', { type: 'button', on: { click: () => openEntry(it, 'recharge') } }, 'Record recharge'),
            h('button', { type: 'button', on: { click: () => openEntry(it, 'expectation') } }, 'Edit expected amount'),
          ),
    );
  }

  function renderEntryForm(c: CaseRecord, it: ItemSummary, draft: EntryDraft): Node {
    const e = draft.errors;
    const titles: Record<EntryDraft['kind'], string> = {
      merchant_report: 'Record merchant report',
      receipt: 'Confirm money received',
      recharge: 'Record recharge',
      expectation: 'Edit expected amount',
    };
    const hints: Record<EntryDraft['kind'], string> = {
      merchant_report: 'What the merchant currently says it has refunded for this item in total. This is a dated status snapshot, not money received; a newer report replaces older ones instead of adding to them.',
      receipt: 'Only record money you have seen arrive (for example on a card statement). Each entry is a separate transaction.',
      recharge: 'Money taken back after a refund for this item.',
      expectation: 'The refund you expect for this item. Changes are kept in the timeline.',
    };
    const isExpectation = draft.kind === 'expectation';
    return h(
      'form',
      {
        class: 'entry-form',
        'aria-labelledby': 'entry-form-title',
        novalidate: true,
        'data-testid': 'entry-form',
        on: {
          submit: (ev) => {
            ev.preventDefault();
            void submitEntry(c, draft);
          },
        },
      },
      h('h4', { id: 'entry-form-title' }, `${titles[draft.kind]} — ${it.item.label}`),
      h('p', { class: 'muted small' }, hints[draft.kind]),
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'entry-amount' }, isExpectation ? 'Expected refund (USD)' : draft.kind === 'merchant_report' ? 'Reported issued total (USD)' : 'Amount (USD)'),
          h('input', { id: 'entry-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: draft.amount, disabled: isExpectation && draft.unknown, ...invalidAttrs('entry-amount', e), on: { input: (ev) => { draft.amount = (ev.target as HTMLInputElement).value; } } }),
          fieldError('entry-amount', e),
        ),
        isExpectation
          ? h(
              'div',
              { class: 'field checkbox' },
              h('input', { id: 'entry-unknown', type: 'checkbox', checked: draft.unknown, on: { change: (ev) => { draft.unknown = (ev.target as HTMLInputElement).checked; e['entry-amount'] = ''; render(); } } }),
              h('label', { for: 'entry-unknown' }, 'Unknown'),
            )
          : h(
              'div',
              { class: 'field' },
              h('label', { for: 'entry-date' }, draft.kind === 'merchant_report' ? 'Date shown by merchant (optional)' : 'Date it happened (optional)'),
              h('input', { id: 'entry-date', type: 'date', value: draft.occurredOn, ...invalidAttrs('entry-date', e), on: { input: (ev) => { draft.occurredOn = (ev.target as HTMLInputElement).value; } } }),
              fieldError('entry-date', e),
            ),
        isExpectation
          ? null
          : h(
              'div',
              { class: 'field' },
              h('label', { for: 'entry-reference' }, draft.kind === 'merchant_report' ? 'Observation reference (optional)' : 'Transaction reference (optional)'),
              h('input', { id: 'entry-reference', type: 'text', maxlength: LIMITS.referenceMax, autocomplete: 'off', value: draft.reference, ...invalidAttrs('entry-reference', e), on: { input: (ev) => { draft.reference = (ev.target as HTMLInputElement).value; } } }),
              fieldError('entry-reference', e),
            ),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'entry-source' }, 'Source'),
          h('input', { id: 'entry-source', type: 'text', maxlength: LIMITS.sourceMax, autocomplete: 'off', value: draft.source, ...invalidAttrs('entry-source', e), on: { input: (ev) => { draft.source = (ev.target as HTMLInputElement).value; } } }),
          fieldError('entry-source', e),
        ),
        h(
          'div',
          { class: 'field wide' },
          h('label', { for: 'entry-note' }, 'Note (optional)'),
          h('input', { id: 'entry-note', type: 'text', maxlength: LIMITS.noteMax, autocomplete: 'off', value: draft.note, ...invalidAttrs('entry-note', e), on: { input: (ev) => { draft.note = (ev.target as HTMLInputElement).value; } } }),
          fieldError('entry-note', e),
        ),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'submit', class: 'primary', disabled: state.busy }, state.busy ? 'Saving…' : 'Save'),
        h('button', { type: 'button', on: { click: () => { state.entryDraft = null; render(); } } }, 'Cancel'),
      ),
    );
  }

  function describeRow(row: TimelineRow): string {
    const e = row.entry;
    switch (e.kind) {
      case 'expectation':
        return row.previousExpectation === undefined
          ? `Expected refund set to ${moneyOrUnknown(e.amountCents)}`
          : `Expected refund changed from ${moneyOrUnknown(row.previousExpectation)} to ${moneyOrUnknown(e.amountCents)}`;
      case 'merchant_report':
        return `Merchant reported ${formatUsd(e.amountCents)} issued (status snapshot)`;
      case 'receipt':
        return `You confirmed ${formatUsd(e.amountCents)} received`;
      case 'recharge':
        return `You recorded a ${formatUsd(e.amountCents)} recharge`;
      case 'void':
        return 'Voided an earlier entry';
    }
  }

  function renderTimeline(c: CaseRecord): Node {
    const rows = buildTimeline(c);
    return h(
      'section',
      { class: 'panel', 'aria-labelledby': 'timeline-heading' },
      h('h2', { id: 'timeline-heading' }, 'Evidence timeline'),
      h('p', { class: 'muted small' }, 'Every entry in the order it was recorded. Voided entries stay here for the record but no longer count.'),
      h(
        'ol',
        { class: 'timeline', 'data-testid': 'timeline' },
        ...rows.map((row) => {
          const e = row.entry;
          const voidable = e.kind === 'merchant_report' || e.kind === 'receipt' || e.kind === 'recharge';
          const target = e.kind === 'void' ? c.entries.find((x) => x.id === e.targetEntryId) : undefined;
          const isVoidOpen = state.voidDraft?.targetEntryId === e.id;
          return h(
            'li',
            { class: `tl tl-${e.kind}${row.voidedBy ? ' tl-voided' : ''}`, 'data-testid': 'timeline-entry', 'data-kind': e.kind },
            h('div', { class: 'tl-main' }, h('span', { class: 'tl-kind' }, KIND_LABEL[e.kind]), ' ', h('span', { class: 'tl-text' }, describeRow(row)), row.voidedBy ? h('span', { class: 'badge badge-voided' }, 'Voided') : null),
            h(
              'div',
              { class: 'tl-meta' },
              `Item: ${row.itemLabel} · Source: ${e.source} · Recorded ${formatTimestamp(e.recordedAt)}`,
              e.occurredOn ? ` · Occurred ${e.occurredOn}` : '',
              'reference' in e && e.reference ? ` · Ref ${e.reference}` : '',
            ),
            target && 'amountCents' in target ? h('div', { class: 'tl-meta' }, `Voided: ${KIND_LABEL[target.kind]} of ${moneyOrUnknown(target.amountCents)} recorded ${formatTimestamp(target.recordedAt)}`) : null,
            e.note ? h('div', { class: 'tl-note' }, e.kind === 'void' ? `Reason: ${e.note}` : `Note: ${e.note}`) : null,
            row.voidedBy ? h('div', { class: 'tl-meta' }, `Voided ${formatTimestamp(row.voidedBy.recordedAt)}: ${row.voidedBy.note}`) : null,
            voidable && !row.voidedBy && !isVoidOpen
              ? h('button', { type: 'button', class: 'link', 'aria-label': `Void ${KIND_LABEL[e.kind]} ${describeRow(row)}`, on: { click: () => { state.voidDraft = { id: deps.newId(), targetEntryId: e.id, reason: '', error: '' }; state.entryDraft = null; render(); document.getElementById('void-reason')?.focus(); } } }, 'Void…')
              : null,
            isVoidOpen && state.voidDraft ? renderVoidForm(c, state.voidDraft) : null,
          );
        }),
      ),
    );
  }

  function renderVoidForm(c: CaseRecord, draft: VoidDraft): Node {
    return h(
      'form',
      { class: 'void-form', novalidate: true, on: { submit: (ev) => { ev.preventDefault(); void submitVoid(c, draft); } } },
      h('label', { for: 'void-reason' }, 'Why is this entry mistaken?'),
      h('input', { id: 'void-reason', type: 'text', maxlength: LIMITS.reasonMax, autocomplete: 'off', value: draft.reason, 'aria-invalid': draft.error ? 'true' : null, 'aria-describedby': draft.error ? 'void-reason-error' : null, on: { input: (ev) => { draft.reason = (ev.target as HTMLInputElement).value; } } }),
      draft.error ? h('span', { class: 'field-error', id: 'void-reason-error' }, draft.error) : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'submit', class: 'primary', disabled: state.busy }, 'Void entry'),
        h('button', { type: 'button', on: { click: () => { state.voidDraft = null; render(); } } }, 'Cancel'),
      ),
    );
  }

  function renderDelete(c: CaseRecord): Node {
    return h(
      'section',
      { class: 'panel', 'aria-labelledby': 'delete-heading' },
      h('h2', { id: 'delete-heading' }, 'Delete case'),
      state.confirmDelete
        ? h(
            'div',
            { class: 'confirm', role: 'group', 'aria-labelledby': 'delete-q' },
            h('p', { id: 'delete-q' }, `Permanently delete “${caseTitle(c)}”, its items and all of its evidence from this browser? This cannot be undone.`),
            h('button', { type: 'button', class: 'danger', id: 'confirm-delete', disabled: state.busy, on: { click: () => void deleteCase(c) } }, 'Permanently delete'),
            h('button', { type: 'button', on: { click: () => { state.confirmDelete = false; render(); } } }, 'Cancel'),
          )
        : h('button', { type: 'button', class: 'danger-outline', on: { click: () => { state.confirmDelete = true; render(); document.getElementById('confirm-delete')?.focus(); } } }, 'Delete case…'),
    );
  }

  async function deleteCase(c: CaseRecord): Promise<void> {
    deletingCaseId = c.id;
    const ok = await run({ kind: 'mutate', command: { type: 'deleteCase', caseId: c.id } }, 'Case deleted.');
    deletingCaseId = null;
    state.confirmDelete = false;
    if (ok) {
      state.view = { name: 'list' };
      render();
      document.getElementById('list-heading')?.focus();
    }
  }

  deps.subscribe(() => void reload());
  render();
  void reload();
}
