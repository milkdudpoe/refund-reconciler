// Toolbar popup: open the dashboard, or capture user-selected refund text from
// the Amazon US tab the popup was opened on. Nothing is written until the user
// explicitly approves a preview; closing or cancelling discards it. Every
// page-derived value is rendered as literal text.

import { acquireSelection, type AcquireDeps, type AcquireProblem } from '../capture/acquire';
import { EXCERPT_MAX_CHARS, analyzeExcerpt, compareOrder, type ExcerptAnalysis, type NotIssuedReason, type UnsupportedReason } from '../capture/parse';
import { checkSourceUrl } from '../capture/source';
import { formatUsd } from '../domain/money';
import { summarizeItem } from '../domain/reconcile';
import type { CaptureOrigin, CaseRecord, RecordEntryCommand, StoreData } from '../domain/types';
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

const NOT_ISSUED_LABEL: Record<NotIssuedReason, string> = {
  recharge: 'charge or recharge wording',
  pending: 'pending wording',
  expected: 'expected or estimated wording',
  purchase_price: 'price or total wording',
  return_received: 'return-received wording',
  unlabelled: 'not described as issued',
};

interface Preview {
  /** Stable capture operation id, reused for every save attempt and recovery. */
  readonly opId: string;
  readonly analysis: ExcerptAnalysis;
  readonly sourceOrigin: CaptureOrigin;
  readonly sourcePath: string | null;
  readonly capturedAt: string;
  caseId: string;
  itemId: string;
  confirmed: boolean;
}

type Phase =
  | { name: 'idle' }
  | { name: 'reading' }
  | { name: 'failed'; message: string }
  | { name: 'preview'; preview: Preview }
  | { name: 'saved'; caseId: string; itemLabel: string; amount: string };

export function startPopup(root: HTMLElement, statusRegion: HTMLElement, deps: PopupDeps): void {
  let load: LoadResult | { status: 'loading' } = { status: 'loading' };
  let phase: Phase = { name: 'idle' };
  let busy = false;
  let notice: { tone: 'success' | 'error' | 'info'; text: string } | null = null;
  /** Fixed for the life of this popup. */
  let source: { id: number | null; origin: string | null } | null = null;
  const sourceReady = deps.sourceTab().then((tab) => {
    const check = checkSourceUrl(tab.url);
    source = { id: tab.id, origin: check.ok ? check.origin : null };
  });

  async function reload(): Promise<void> {
    load = await loadStore(deps.area);
    // While a save is in flight its own reply decides; afterwards, an id that
    // appears in saved data means an uncertain save did commit.
    if (!busy && phase.name === 'preview' && load.status === 'ok' && storeHasEntry(load.store, phase.preview.opId)) markSaved(phase.preview, true);
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
        capturedAt: deps.now(),
        caseId: '',
        itemId: '',
        confirmed: false,
      },
    };
    render();
    document.getElementById('preview-heading')?.focus();
  }

  function cancel(): void {
    phase = { name: 'idle' };
    setNotice('info', 'Capture discarded. Nothing was saved.');
    render();
  }

  function markSaved(p: Preview, recovered: boolean): void {
    const c = realCases().find((x) => x.id === p.caseId);
    const item = c?.items.find((i) => i.id === p.itemId);
    phase = { name: 'saved', caseId: p.caseId, itemLabel: item?.label ?? 'the selected item', amount: p.analysis.issued ? formatUsd(p.analysis.issued.cents) : '' };
    if (recovered) setNotice('success', 'Saved. The extension’s reply was lost, but the report is in your saved data, so it was not recorded twice.');
  }

  function blockers(p: Preview): string[] {
    const out: string[] = [];
    const c = realCases().find((x) => x.id === p.caseId);
    if (!c) out.push('Choose one of your cases.');
    else if (!c.items.some((i) => i.id === p.itemId)) out.push('Choose the item this refund line is for.');
    if (c && orderCompat(p, c) === 'mismatch') out.push('The selected text names a different order than this case.');
    if (!p.confirmed) out.push('Confirm that the amount applies to this item only.');
    return out;
  }

  function orderCompat(p: Preview, c: CaseRecord) {
    return compareOrder(p.analysis.orderRef.status === 'found' ? p.analysis.orderRef.value : null, c.orderRef);
  }

  async function save(p: Preview): Promise<void> {
    const issued = p.analysis.issued;
    if (!issued || blockers(p).length > 0) {
      setNotice('error', 'Complete the highlighted steps first. Nothing was saved.');
      render();
      return;
    }
    const entry: RecordEntryCommand['entry'] = {
      id: p.opId,
      kind: 'merchant_report',
      itemId: p.itemId,
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
    busy = true;
    render();
    const res = await deps.send({ kind: 'mutate', command: { type: 'recordEntry', caseId: p.caseId, entry } });
    busy = false;
    if (!res.ok && res.error.code === 'outcome_unknown') {
      // Never treat a lost reply as failure: look for this capture's own id.
      const check = await loadStore(deps.area);
      load = check;
      if (check.status === 'ok' && storeHasEntry(check.store, p.opId)) {
        markSaved(p, true);
      } else {
        setNotice(
          'error',
          check.status === 'ok'
            ? 'Could not confirm this save: the report is not in your saved data right now. Your preview is kept. Saving again is safe because it reuses the same capture ID, so it cannot be recorded twice.'
            : 'Could not confirm whether this report was saved, and saved data could not be re-read. Your preview is kept. Saving again is safe because it reuses the same capture ID, so it cannot be recorded twice.',
        );
      }
      render();
      return;
    }
    if (res.ok) {
      markSaved(p, false);
      setNotice('success', res.outcome === 'duplicate' ? 'Already recorded — nothing was added twice.' : 'Merchant report saved. No receipt was recorded.');
    } else if (res.error.code === 'write_rejected') {
      setNotice('error', `${res.error.message} Your preview is kept so you can try again.`);
    } else {
      setNotice('error', `${res.error.message} Your preview is kept.`);
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
        );
      case 'failed':
        return h(
          'div',
          { 'data-testid': 'capture-failed' },
          h('p', { class: 'notice notice-error', role: 'alert' }, phase.message),
          h('p', { class: 'muted small' }, 'Nothing was saved. You can also record the report manually in the dashboard.'),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', on: { click: () => void capture() } }, 'Try again'), dashboardButton()),
        );
      case 'saved':
        return h(
          'div',
          { 'data-testid': 'capture-saved' },
          h('p', {}, `Saved a merchant report of ${phase.amount} issued for “${phase.itemLabel}”. It is the merchant’s statement only; confirm receipt separately when the money arrives.`),
          h('div', { class: 'actions' }, dashboardButton(), h('button', { type: 'button', on: { click: () => { phase = { name: 'idle' }; notice = null; render(); } } }, 'Capture another')),
        );
      case 'preview':
        return renderPreview(phase.preview);
    }
  }

  function renderPreview(p: Preview): Node {
    const a = p.analysis;
    const issued = a.issued;
    return h(
      'section',
      { 'aria-labelledby': 'preview-heading', 'data-testid': 'preview' },
      h('h2', { id: 'preview-heading', tabindex: -1 }, 'Preview — not saved yet'),
      h('h3', {}, 'Selected text'),
      h('pre', { class: 'excerpt', 'data-testid': 'excerpt' }, a.excerpt),
      h(
        'dl',
        { class: 'detected', 'data-testid': 'detected' },
        h('div', {}, h('dt', {}, 'Source'), h('dd', { 'data-testid': 'detected-source' }, `${p.sourceOrigin}${p.sourcePath ?? ''}`)),
        h('div', {}, h('dt', {}, 'Issued amount'), h('dd', { 'data-testid': 'detected-amount' }, issued ? `${formatUsd(issued.cents)} (from “${issued.amountText}”)` : 'Not found')),
        h('div', {}, h('dt', {}, 'Order'), h('dd', { 'data-testid': 'detected-order' }, a.orderRef.status === 'found' ? a.orderRef.value : a.orderRef.status === 'ambiguous' ? `Ambiguous: ${a.orderRef.values.join(', ')}` : 'Not in selection')),
        h('div', {}, h('dt', {}, 'Date issued'), h('dd', { 'data-testid': 'detected-date' }, a.date.status === 'found' ? a.date.value : a.date.status === 'unknown' ? 'Unknown (not a single clear date in the refund statement)' : 'Unknown')),
      ),
      a.notIssued.length > 0
        ? h('div', { 'data-testid': 'not-issued' }, h('h3', {}, 'Amounts not treated as issued'), h('ul', {}, ...a.notIssued.map((n) => h('li', {}, `${n.amountText}: ${NOT_ISSUED_LABEL[n.reason]}`))))
        : null,
      issued ? renderAssign(p, issued.cents) : renderUnsupported(a),
    );
  }

  function renderUnsupported(a: ExcerptAnalysis): Node {
    return h(
      'div',
      { 'data-testid': 'unsupported' },
      h('h3', {}, 'Cannot propose a report from this selection'),
      h('ul', { class: 'problems' }, ...a.problems.map((r) => h('li', {}, PROBLEM_MESSAGE[r]))),
      h('p', { class: 'muted small' }, 'Nothing was saved. Narrow the selection to the refund line for one item and capture again, or enter the report manually in the dashboard.'),
      h('div', { class: 'actions' }, h('button', { type: 'button', on: { click: cancel } }, 'Discard'), dashboardButton('Enter manually in dashboard')),
    );
  }

  function renderAssign(p: Preview, cents: number): Node {
    const cases = realCases();
    if (load.status !== 'ok') {
      return h(
        'div',
        {},
        h('p', { class: 'notice notice-error' }, 'Saved cases can’t be read right now, so this report can’t be assigned. Nothing was saved.'),
        h('div', { class: 'actions' }, h('button', { type: 'button', on: { click: () => void reload() } }, 'Try again'), h('button', { type: 'button', on: { click: cancel } }, 'Cancel')),
      );
    }
    if (cases.length === 0) {
      return h(
        'div',
        { 'data-testid': 'no-cases' },
        h('p', {}, 'You have no cases yet. Create a case for this order in the dashboard, then capture the text again. (Synthetic demo cases cannot receive captured evidence.)'),
        h('div', { class: 'actions' }, dashboardButton('Create a case in the dashboard', '#create'), h('button', { type: 'button', on: { click: cancel } }, 'Cancel')),
      );
    }
    const selectedCase = cases.find((c) => c.id === p.caseId);
    const compat = selectedCase ? orderCompat(p, selectedCase) : null;
    const item = selectedCase?.items.find((i) => i.id === p.itemId);
    const problems = blockers(p);
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
          { id: 'capture-case', on: { change: (ev) => { p.caseId = (ev.target as HTMLSelectElement).value; p.itemId = ''; p.confirmed = false; render(); } } },
          h('option', { value: '', selected: p.caseId === '' }, 'Choose a case…'),
          ...cases.map((c) => h('option', { value: c.id, selected: c.id === p.caseId }, c.orderRef ? `Order ${c.orderRef}` : `Case with ${c.items.length} item${c.items.length === 1 ? '' : 's'}: ${c.items.map((i) => i.label).join(', ')}`)),
        ),
      ),
      compat === 'mismatch'
        ? h('p', { class: 'notice notice-error', 'data-testid': 'order-mismatch' }, 'This case is for a different order than the one named in the selected text. Choose the matching case, or create one for that order.')
        : compat === 'case_has_no_order' || compat === 'not_comparable'
          ? h('p', { class: 'muted small', 'data-testid': 'order-unchecked' }, 'This case has no recognisable Amazon order number, so the order in the selected text could not be checked against it.')
          : null,
      selectedCase
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'capture-item' }, 'Item'),
            h(
              'select',
              { id: 'capture-item', on: { change: (ev) => { p.itemId = (ev.target as HTMLSelectElement).value; p.confirmed = false; render(); } } },
              h('option', { value: '', selected: p.itemId === '' }, 'Choose an item…'),
              ...selectedCase.items.map((i) => h('option', { value: i.id, selected: i.id === p.itemId }, i.label)),
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
              h('input', { id: 'capture-confirm', type: 'checkbox', checked: p.confirmed, on: { change: (ev) => { p.confirmed = (ev.target as HTMLInputElement).checked; render(); } } }),
              h('label', { for: 'capture-confirm' }, `The ${formatUsd(cents)} in this text is the refund for this one item, not for the whole order or other items.`),
            ),
          )
        : null,
      h('p', { class: 'muted small', 'data-testid': 'blockers' }, problems.join(' ')),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'submit', class: 'primary', disabled: busy || problems.length > 0 }, busy ? 'Saving…' : 'Save merchant report'),
        h('button', { type: 'button', disabled: busy, on: { click: cancel } }, 'Cancel'),
        dashboardButton('Create a case', '#create'),
      ),
    );
  }

  deps.subscribe(() => void reload());
  render();
  void reload();
}
