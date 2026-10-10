// Toolbar popup: open the dashboard, or capture user-selected refund text from
// the Amazon US tab the popup was opened on. Nothing is written until the user
// explicitly approves a preview; closing or cancelling discards it. Every
// page-derived value is rendered as literal text.

import { acquireSelection, type AcquireDeps, type AcquireProblem } from '../capture/acquire';
import { EXCERPT_MAX_CHARS, analyzeExcerpt, type ExcerptAnalysis, type NotIssuedReason, type UnsupportedReason } from '../capture/parse';
import { assessOrder, type OrderBlock, type OrderContext } from '../capture/order';
import { checkSourceUrl } from '../capture/source';
import { formatUsd } from '../domain/money';
import { summarizeItem } from '../domain/reconcile';
import type { CaptureOrigin, CaseRecord, RecordEntryCommand, StoreData } from '../domain/types';
import type { Request } from '../background/messages';
import { CAPTURE_SOURCE } from '../domain/validate';
import { loadStore, type LoadResult } from '../persistence/storage';
import type { AppDeps } from '../ui/deps';
import { h, replaceContent } from '../ui/dom';
import { ITEM_STATUS_LABEL } from '../ui/labels';

export interface PopupDeps extends AppDeps {
  acquire: AcquireDeps;
  /** The tab the toolbar UI was opened on, resolved once when the popup opens. */
  sourceTab(): Promise<{ id: number | null; url: string | undefined }>;
  openDashboard(hash: string): void;
  now(): string;
}

export const ACQUIRE_MESSAGE: Record<AcquireProblem, string> = {
  no_access:
    'Refund Reconciler has no access to this tab. Click the Refund Reconciler toolbar button while the Amazon page is the active tab, then choose Capture. Access is temporary and ends when you leave the page.',
  restricted: 'This is a browser or extension page, which cannot be read. Open your Amazon US order or refund page and try again.',
  unsupported_scheme: 'Only secure (https) Amazon US pages are supported.',
  unsupported_host: 'Only pages on amazon.com or www.amazon.com are supported. Other sites and other Amazon country sites are not.',
  no_tab: 'Could not tell which tab to read. Click the toolbar button while the Amazon page is the active tab.',
  tab_closed: 'The Amazon tab was closed. Nothing was captured.',
  navigated: 'The tab moved to a different page after you opened this panel. Nothing was captured. Click the toolbar button again on the page you want.',
  empty: 'No text is selected. Highlight the refund line for one item on the Amazon page (for example “Refund issued: $35.00”), then choose Capture.',
  editable: 'The selection is inside a form field. Select the refund text on the page itself, not text in a box you can type in.',
  too_long: `The selection is too long (the limit is ${EXCERPT_MAX_CHARS.toLocaleString('en-US')} characters). Nothing was read. Select just the refund lines for one item.`,
  injection_failed: 'The page could not be read. Reload the Amazon page and try again, or enter the report manually in the dashboard.',
};

export const PROBLEM_MESSAGE: Record<UnsupportedReason, string> = {
  empty: 'The selection has no readable text.',
  too_long: `The selection is longer than ${EXCERPT_MAX_CHARS.toLocaleString('en-US')} characters.`,
  unsupported_currency: 'The text mentions a currency other than US dollars. Only Amazon US refunds in USD are supported.',
  malformed_amount: 'An amount in the text could not be read safely (for example a sign, too many decimal places, or broken digit grouping).',
  zero_amount: 'The issued amount is $0.00, which is not a refund to record.',
  no_issued_amount: 'No amount is clearly described as issued or refunded. Purchase prices, expected, estimated and pending amounts are not treated as issued.',
  multiple_issued_amounts: 'More than one issued amount was found. Select only the lines for one item.',
  conflicting_wording: 'Refund wording is mixed with pending, expected, price or charge wording, or with several amounts, so the issued amount is unclear.',
  aggregate_order_total: 'This looks like an order-level refund total. It cannot be assigned to one item, split between items, or used to settle several. Select an item-specific refund line instead.',
  multiple_order_refs: 'More than one order number was found. Select text from one order only.',
};

export const ORDER_BLOCK_MESSAGE: Record<OrderBlock, string> = {
  source_ambiguous: 'The page address names more than one order, so the order this refund belongs to is unclear. Open the page for a single order and capture again.',
  excerpt_ambiguous: 'More than one order number was found. Select text from one order only.',
  source_excerpt_conflict: 'The page address and the selected text name different orders. Capture from the page of the order the refund line belongs to.',
  case_mismatch: 'This case is for a different order than the one named by the page address or the selected text. Choose the matching case, or create one for that order.',
};

const NOT_ISSUED_LABEL: Record<NotIssuedReason, string> = {
  recharge: 'charge or recharge wording',
  pending: 'pending wording',
  expected: 'expected or estimated wording',
  purchase_price: 'price or total wording',
  return_received: 'return-received wording',
  unlabelled: 'not described as issued',
};

interface Draft {
  caseId: string;
  itemId: string;
  confirmed: boolean;
}

/**
 * An approved save, frozen at the moment Save was pressed. The command, any
 * retry and the result message all use this snapshot, never the live draft,
 * so a submitted capture can never be retargeted under the same ID.
 */
interface SubmittedOp {
  readonly request: Request;
  readonly caseId: string;
  readonly caseTitle: string;
  readonly itemLabel: string;
  readonly amount: string;
  /** sending: awaiting the reply; uncertain: no valid reply and not found in saved data yet. */
  state: 'sending' | 'uncertain';
}

interface Preview {
  /** Stable capture operation id, reused for every save attempt and recovery. */
  readonly opId: string;
  readonly analysis: ExcerptAnalysis;
  readonly sourceOrigin: CaptureOrigin;
  readonly sourcePath: string | null;
  /** Order named by the page URL, kept apart from the order in the selected text. */
  readonly sourceOrder: OrderContext;
  readonly capturedAt: string;
  /** Editable only while nothing is submitted. */
  readonly draft: Draft;
  /** Set from Save until the outcome is known; while set, the assignment is locked. */
  op: SubmittedOp | null;
}

type Phase =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'failed'; message: string }
  | { name: 'preview'; preview: Preview }
  | { name: 'saved'; op: SubmittedOp };

function caseTitle(c: CaseRecord): string {
  return c.orderRef ? `Order ${c.orderRef}` : `Case with ${c.items.length} item${c.items.length === 1 ? '' : 's'}: ${c.items.map((i) => i.label).join(', ')}`;
}

export function startPopup(root: HTMLElement, statusRegion: HTMLElement, deps: PopupDeps): void {
  let load: LoadResult | { status: 'loading' } = { status: 'loading' };
  let phase: Phase = { name: 'idle' };
  let notice: { tone: 'success' | 'error' | 'info'; text: string } | null = null;
  /** Fixed for the life of this popup. */
  let source: { id: number | null; origin: string | null } | null = null;
  const sourceReady = deps.sourceTab().then((tab) => {
    const check = checkSourceUrl(tab.url);
    source = { id: tab.id, origin: check.ok ? check.origin : null };
  });

  async function reload(): Promise<void> {
    load = await loadStore(deps.area);
    // While a save is in flight its own reply decides. Afterwards, the
    // operation's id appearing in saved data means an uncertain save committed.
    if (phase.name === 'preview') {
      const op = phase.preview.op;
      if (op?.state === 'uncertain' && load.status === 'ok' && storeHasEntry(load.store, phase.preview.opId)) markSaved(op, true);
    }
    render();
  }

  function storeHasEntry(data: StoreData, id: string): boolean {
    return data.cases.some((c) => c.entries.some((e) => e.id === id));
  }

  function setNotice(tone: 'success' | 'error' | 'info', text: string): void {
    notice = { tone, text };
    statusRegion.textContent = text;
  }

  function realCases(): CaseRecord[] {
    return load.status === 'ok' ? load.store.cases.filter((c) => !c.isDemo) : [];
  }

  async function capture(): Promise<void> {
    notice = null;
    phase = { name: 'reading' };
    render();
    await sourceReady;
    const result = await acquireSelection(deps.acquire, source?.id ?? null, source?.origin ?? null);
    // Fresh case list for the assignment step.
    load = await loadStore(deps.area);
    if (!result.ok) {
      phase = { name: 'failed', message: ACQUIRE_MESSAGE[result.problem] };
      render();
      return;
    }
    phase = {
      name: 'preview',
      preview: {
        opId: `cap-${deps.newId()}`,
        analysis: analyzeExcerpt(result.text),
        sourceOrigin: result.sourceOrigin,
        sourcePath: result.sourcePath,
        sourceOrder: result.sourceOrder,
        capturedAt: deps.now(),
        draft: { caseId: '', itemId: '', confirmed: false },
        op: null,
      },
    };
    render();
    document.getElementById('preview-heading')?.focus();
  }

  function cancel(p: Preview | null): void {
    const op = p?.op ?? null;
    phase = { name: 'idle' };
    if (op === null) {
      setNotice('info', 'Capture discarded. Nothing was saved.');
    } else {
      // A submitted operation with no confirmed outcome may already be saved.
      setNotice(
        'info',
        `Stopped waiting for this capture. It may already have been saved for “${op.itemLabel}”; check that item in the dashboard before capturing the same text again.`,
      );
    }
    render();
  }

  function markSaved(op: SubmittedOp, recovered: boolean): void {
    phase = { name: 'saved', op };
    if (recovered) setNotice('success', 'Saved. The extension’s reply was lost, but the report is in your saved data, so it was not recorded twice.');
  }

  function orderCheck(p: Preview, c?: CaseRecord) {
    return assessOrder(p.analysis.orderRef, p.sourceOrder, c === undefined ? undefined : c.orderRef);
  }

  function blockers(p: Preview): string[] {
    const out: string[] = [];
    const d = p.draft;
    const c = realCases().find((x) => x.id === d.caseId);
    if (!c) out.push('Choose one of your cases.');
    else if (!c.items.some((i) => i.id === d.itemId)) out.push('Choose the item this refund line is for.');
    if (c) {
      const check = orderCheck(p, c);
      if (!check.ok) out.push(ORDER_BLOCK_MESSAGE[check.block]);
    }
    if (!d.confirmed) out.push('Confirm that the amount applies to this item only.');
    return out;
  }

  /** Freezes the approved draft into the operation that will be sent and retried. */
  function approve(p: Preview): SubmittedOp | null {
    const issued = p.analysis.issued;
    const c = realCases().find((x) => x.id === p.draft.caseId);
    const item = c?.items.find((i) => i.id === p.draft.itemId);
    if (!issued || !c || !item || blockers(p).length > 0) return null;
    const entry: RecordEntryCommand['entry'] = {
      id: p.opId,
      kind: 'merchant_report',
      itemId: item.id,
      amountCents: issued.cents,
      occurredOn: p.analysis.date.status === 'found' ? p.analysis.date.value : null,
      source: CAPTURE_SOURCE,
      note: '',
      reference: null,
      capture: {
        sourceOrigin: p.sourceOrigin,
        sourcePath: p.sourcePath,
        capturedAt: p.capturedAt,
        excerpt: p.analysis.excerpt,
        parserVersion: p.analysis.parserVersion,
        approvedAmountText: issued.amountText,
        detectedOrderRef: p.analysis.orderRef.status === 'found' ? p.analysis.orderRef.value : null,
        itemApplicabilityConfirmed: true,
      },
    };
    const request: Request = { kind: 'mutate', command: { type: 'recordEntry', caseId: c.id, entry } };
    return { request: structuredClone(request), caseId: c.id, caseTitle: caseTitle(c), itemLabel: item.label, amount: formatUsd(issued.cents), state: 'sending' };
  }

  async function save(p: Preview): Promise<void> {
    if (p.op?.state === 'sending') return;
    // A pending (uncertain) operation is retried exactly as approved; only an
    // unsubmitted draft becomes a new operation.
    let op: SubmittedOp;
    if (p.op) {
      op = p.op;
    } else {
      const approved = approve(p);
      if (!approved) {
        setNotice('error', 'Complete the highlighted steps first. Nothing was saved.');
        render();
        return;
      }
      op = approved;
    }
    op.state = 'sending';
    p.op = op;
    render();
    const res = await deps.send(op.request);
    if (!res.ok && res.error.code === 'outcome_unknown') {
      // Never treat a lost reply as failure: look for this operation's own id.
      op.state = 'uncertain';
      const check = await loadStore(deps.area);
      load = check;
      if (check.status === 'ok' && storeHasEntry(check.store, p.opId)) {
        markSaved(op, true);
      } else {
        setNotice(
          'error',
          check.status === 'ok'
            ? `Could not confirm this save: the report for “${op.itemLabel}” is not in your saved data right now. The approved assignment is kept and locked. Retrying is safe because it resends the same capture with the same ID, so it cannot be recorded twice.`
            : `Could not confirm whether the report for “${op.itemLabel}” was saved, and saved data could not be re-read. The approved assignment is kept and locked. Retrying is safe because it resends the same capture with the same ID, so it cannot be recorded twice.`,
        );
      }
      render();
      return;
    }
    if (res.ok) {
      markSaved(op, false);
      setNotice('success', res.outcome === 'duplicate' ? 'Already recorded — nothing was added twice.' : 'Merchant report saved. No receipt was recorded.');
    } else {
      // A definite answer that nothing was written: the draft can be edited again.
      p.op = null;
      setNotice('error', `${res.error.message} Your preview is kept${res.error.code === 'write_rejected' ? ' so you can try again' : ''}.`);
    }
    await reload();
  }

  // ---- Rendering ----

  function render(): void {
    const children: (Node | null)[] = [];
    if (notice) children.push(h('p', { class: `notice notice-${notice.tone}`, role: notice.tone === 'error' ? 'alert' : null, 'data-testid': 'notice' }, notice.text));
    children.push(renderBody());
    replaceContent(root, children);
  }

  function dashboardButton(label = 'Open dashboard', hash = ''): Node {
    return h('button', { type: 'button', on: { click: () => deps.openDashboard(hash) } }, label);
  }

  function renderBody(): Node {
    switch (phase.name) {
      case 'idle':
      case 'reading':
        return h(
          'div',
          {},
          h(
            'p',
            { class: 'muted small' },
            'To capture a refund record: on an Amazon US page, highlight the refund line for one item, then choose Capture. You will see a preview; nothing is saved until you approve it.',
          ),
          h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'primary', disabled: phase.name === 'reading', on: { click: () => void capture() } }, phase.name === 'reading' ? 'Reading selection…' : 'Capture selected refund text'),
            dashboardButton(),
          ),
          h(
            'p',
            { class: 'muted small' },
            'New here? ',
            h('button', { type: 'button', class: 'link', on: { click: () => deps.openDashboard('#help') } }, 'How to use Refund Reconciler'),
            ' opens a short guide in the dashboard.',
          ),
        );
      case 'failed':
        return h(
          'div',
          { 'data-testid': 'capture-failed' },
          h('p', { class: 'notice notice-error', role: 'alert' }, phase.message),
          h('p', { class: 'muted small' }, 'Nothing was saved. You can also record the report manually in the dashboard.'),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', on: { click: () => void capture() } }, 'Try again'), dashboardButton()),
        );
      case 'saved': {
        const op = phase.op;
        return h(
          'div',
          { 'data-testid': 'capture-saved' },
          h('p', {}, `Saved a merchant report of ${op.amount} issued for “${op.itemLabel}” (${op.caseTitle}). It is the merchant’s statement only; confirm receipt separately when the money arrives.`),
          h('div', { class: 'actions' }, dashboardButton(), h('button', { type: 'button', on: { click: () => { phase = { name: 'idle' }; notice = null; render(); } } }, 'Capture another')),
        );
      }
      case 'preview':
        return renderPreview(phase.preview);
    }
  }

  function orderText(ctx: OrderContext, none: string): string {
    return ctx.status === 'found' ? ctx.value : ctx.status === 'ambiguous' ? `Ambiguous: ${ctx.values.join(', ')}` : none;
  }

  function renderPreview(p: Preview): Node {
    const a = p.analysis;
    const issued = a.issued;
    const order = orderCheck(p);
    // Order contradictions within the capture itself block any proposal.
    const orderBlock = !order.ok && order.block !== 'excerpt_ambiguous' ? order.block : null;
    return h(
      'section',
      { 'aria-labelledby': 'preview-heading', 'data-testid': 'preview' },
      h('h2', { id: 'preview-heading', tabindex: -1 }, p.op ? 'Submitted — waiting for confirmation' : 'Preview — not saved yet'),
      h('h3', {}, 'Selected text'),
      h('pre', { class: 'excerpt', 'data-testid': 'excerpt' }, a.excerpt),
      h(
        'dl',
        { class: 'detected', 'data-testid': 'detected' },
        h('div', {}, h('dt', {}, 'Source'), h('dd', { 'data-testid': 'detected-source' }, `${p.sourceOrigin}${p.sourcePath ?? ''}`)),
        h('div', {}, h('dt', {}, 'Issued amount'), h('dd', { 'data-testid': 'detected-amount' }, issued ? `${formatUsd(issued.cents)} (from “${issued.amountText}”)` : 'Not found')),
        h('div', {}, h('dt', {}, 'Order in selection'), h('dd', { 'data-testid': 'detected-order' }, orderText(a.orderRef, 'Not in selection'))),
        h('div', {}, h('dt', {}, 'Order in page address'), h('dd', { 'data-testid': 'source-order' }, orderText(p.sourceOrder, 'Not in address'))),
        h('div', {}, h('dt', {}, 'Date issued'), h('dd', { 'data-testid': 'detected-date' }, a.date.status === 'found' ? a.date.value : a.date.status === 'unknown' ? 'Unknown (not a single clear date in the refund statement)' : 'Unknown')),
      ),
      a.notIssued.length > 0
        ? h('div', { 'data-testid': 'not-issued' }, h('h3', {}, 'Amounts not treated as issued'), h('ul', {}, ...a.notIssued.map((n) => h('li', {}, `${n.amountText}: ${NOT_ISSUED_LABEL[n.reason]}`))))
        : null,
      issued && orderBlock === null ? renderAssign(p, issued.cents) : renderUnsupported(p, orderBlock),
    );
  }

  function renderUnsupported(p: Preview, orderBlock: OrderBlock | null): Node {
    const reasons = [...p.analysis.problems.map((r) => PROBLEM_MESSAGE[r]), ...(orderBlock ? [ORDER_BLOCK_MESSAGE[orderBlock]] : [])];
    return h(
      'div',
      { 'data-testid': 'unsupported' },
      h('h3', {}, 'Cannot propose a report from this selection'),
      h('ul', { class: 'problems' }, ...reasons.map((r) => h('li', {}, r))),
      h('p', { class: 'muted small' }, 'Nothing was saved. Narrow the selection to the refund line for one item and capture again, or enter the report manually in the dashboard.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', on: { click: () => cancel(p) } }, 'Discard'), dashboardButton('Enter manually in dashboard')),
    );
  }

  /** Shown instead of the editable form once Save was pressed and the outcome is not yet known. */
  function renderSubmitted(p: Preview, op: SubmittedOp): Node {
    const sending = op.state === 'sending';
    return h(
      'div',
      { class: 'assign', 'data-testid': 'submitted' },
      h('h3', {}, 'Approved assignment (locked)'),
      h('p', { class: 'proposal', 'data-testid': 'submitted-target' }, `Merchant report of ${op.amount} issued for “${op.itemLabel}” (${op.caseTitle}).`),
      load.status === 'ok'
        ? null
        : h(
            'p',
            { class: 'muted small', 'data-testid': 'cases-unreadable' },
            'Saved cases can’t be read right now. This does not mean the save failed; reading again will show whether it was recorded.',
          ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'primary', disabled: sending, on: { click: () => void save(p) } }, sending ? 'Saving…' : 'Retry the same save'),
        load.status === 'ok' ? null : h('button', { type: 'button', disabled: sending, on: { click: () => void reload() } }, 'Read saved data again'),
        h('button', { type: 'button', disabled: sending, on: { click: () => cancel(p) } }, 'Stop waiting'),
      ),
    );
  }

  function renderAssign(p: Preview, cents: number): Node {
    if (p.op) return renderSubmitted(p, p.op);
    const d = p.draft;
    const cases = realCases();
    if (load.status !== 'ok') {
      // Only what is known: the list can't be read now. Nothing has been submitted from this preview.
      return h(
        'div',
        { 'data-testid': 'cases-unreadable' },
        h('p', { class: 'notice notice-error' }, 'Saved cases can’t be read right now, so this report can’t be assigned yet. Your preview is kept and has not been submitted.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', on: { click: () => void reload() } }, 'Try again'), h('button', { type: 'button', on: { click: () => cancel(p) } }, 'Cancel')),
      );
    }
    if (cases.length === 0) {
      return h(
        'div',
        { 'data-testid': 'no-cases' },
        h('p', {}, 'You have no cases yet. Create a case for this order in the dashboard, then capture the text again. (Synthetic demo cases cannot receive captured evidence.)'),
        h('div', { class: 'actions' }, dashboardButton('Create a case in the dashboard', '#create'), h('button', { type: 'button', on: { click: () => cancel(p) } }, 'Cancel')),
      );
    }
    const selectedCase = cases.find((c) => c.id === d.caseId);
    const check = selectedCase ? orderCheck(p, selectedCase) : null;
    const item = selectedCase?.items.find((i) => i.id === d.itemId);
    const problems = blockers(p);
    // Change handlers ignore input once an operation is submitted.
    const edit = (fn: () => void) => () => {
      if (p.op) return;
      fn();
      render();
    };
    return h(
      'form',
      {
        class: 'assign',
        novalidate: true,
        'data-testid': 'assign',
        on: { submit: (ev) => { ev.preventDefault(); void save(p); } },
      },
      h('h3', {}, 'Assign to an item'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'capture-case' }, 'Case'),
        h(
          'select',
          { id: 'capture-case', on: { change: (ev) => edit(() => { d.caseId = (ev.target as HTMLSelectElement).value; d.itemId = ''; d.confirmed = false; })() } },
          h('option', { value: '', selected: d.caseId === '' }, 'Choose a case…'),
          ...cases.map((c) => h('option', { value: c.id, selected: c.id === d.caseId }, caseTitle(c))),
        ),
      ),
      check && !check.ok
        ? h('p', { class: 'notice notice-error', 'data-testid': 'order-mismatch' }, ORDER_BLOCK_MESSAGE[check.block])
        : check?.ok && (check.caseCheck === 'case_has_no_order' || check.caseCheck === 'not_comparable')
          ? h('p', { class: 'muted small', 'data-testid': 'order-unchecked' }, 'This case has no recognisable Amazon order number, so the order named by the page or selected text could not be checked against it.')
          : null,
      selectedCase
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'capture-item' }, 'Item'),
            h(
              'select',
              { id: 'capture-item', on: { change: (ev) => edit(() => { d.itemId = (ev.target as HTMLSelectElement).value; d.confirmed = false; })() } },
              h('option', { value: '', selected: d.itemId === '' }, 'Choose an item…'),
              ...selectedCase.items.map((i) => h('option', { value: i.id, selected: i.id === d.itemId }, i.label)),
            ),
          )
        : null,
      selectedCase && item
        ? h(
            'div',
            {},
            h(
              'p',
              { class: 'proposal', 'data-testid': 'proposal' },
              `Proposed: add a merchant report snapshot saying Amazon has issued ${formatUsd(cents)} in total for “${item.label}”. It replaces earlier reports for this item rather than adding to them. It does not record money received, change the expected amount, or create a recharge. Current status: ${ITEM_STATUS_LABEL[summarizeItem(selectedCase, item).status]}.`,
            ),
            h(
              'div',
              { class: 'field checkbox' },
              h('input', { id: 'capture-confirm', type: 'checkbox', checked: d.confirmed, on: { change: (ev) => edit(() => { d.confirmed = (ev.target as HTMLInputElement).checked; })() } }),
              h('label', { for: 'capture-confirm' }, `The ${formatUsd(cents)} in this text is the refund for this one item, not for the whole order or other items.`),
            ),
          )
        : null,
      h('p', { class: 'muted small', 'data-testid': 'blockers' }, problems.join(' ')),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'submit', class: 'primary', disabled: problems.length > 0 }, 'Save merchant report'),
        h('button', { type: 'button', on: { click: () => cancel(p) } }, 'Cancel'),
        dashboardButton('Create a case', '#create'),
      ),
    );
  }

  deps.subscribe(() => void reload());
  render();
  void reload();
}
