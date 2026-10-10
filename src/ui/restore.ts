// Dashboard flow for restoring a local backup file into an EMPTY ledger:
// choose a file → validate it locally → preview → check the destination
// freshly → explicit Restore → report the known outcome. The file's contents
// stay in this panel's memory only; nothing is written before Restore, and
// the service worker re-validates everything at commit time.

import { formatUsd } from '../domain/money';
import type { CaseRecord, StoreData } from '../domain/types';
import { parseBackupEnvelope, type ParsedBackup } from '../domain/validate';
import type { RestoreExpectation } from '../domain/restore';
import { MAX_BACKUP_BYTES, countBackup } from '../export/backup';
import type { LedgerState } from '../vault/state';
import type { AppDeps } from './deps';
import { h } from './dom';
import { KIND_LABEL, formatTimestamp } from './labels';

type Tone = 'success' | 'error' | 'info';

/** Destination eligibility, from a fresh validated read. */
type Destination =
  | { kind: 'checking' }
  | { kind: 'eligible'; expected: RestoreExpectation }
  | { kind: 'not_empty'; real: number; demo: number }
  | { kind: 'blocked'; reason: string }
  /** Storage kept changing while it was being read. */
  | { kind: 'unsettled' };

/** An approved restore. Frozen at approval; every retry sends exactly this. */
interface Operation {
  readonly id: string;
  readonly backup: ParsedBackup;
  readonly expected: RestoreExpectation;
  readonly fileName: string;
  /** Storage-change generation when the request was (last) sent. */
  sentGen: number;
}

/**
 * Whether current saved data still matches a completed restore. The commit
 * itself is known regardless; this only qualifies what is in storage now.
 * `changed` is final. `current` is only set by a read that no storage change
 * overtook.
 */
type CompletionFreshness = 'checking' | 'current' | 'changed' | 'unverified';

interface Done {
  readonly outcome: 'applied' | 'duplicate' | 'recovered';
  readonly fileName: string;
  readonly caseCount: number;
  readonly operationId: string;
  /** Destination revision written by the restore, when known from the reply or receipt. */
  readonly revision: number | null;
  freshness: CompletionFreshness;
}

interface Panel {
  returnFocusId: string;
  phase: 'choose' | 'reading' | 'invalid' | 'empty_backup' | 'preview' | 'sending' | 'uncertain' | 'done';
  file: { name: string; size: number } | null;
  error: string;
  /** The validated backup (bounded temporary state; discarded on close). */
  backup: ParsedBackup | null;
  dest: Destination;
  /** Storage generation when the destination read that produced `dest` started. */
  destGen: number;
  op: Operation | null;
  done: Done | null;
  feedback: { tone: Tone; text: string } | null;
}

export interface RestoreHost {
  deps: AppDeps;
  render: () => void;
  announce: (text: string) => void;
  /** Incremented synchronously on every storage change event. */
  storageGen: () => number;
}

export interface RestoreController {
  open(returnFocusId: string): void;
  isOpen(): boolean;
  /** Call synchronously when a storage change event arrives, after the generation was incremented. */
  onStorageChange(): void;
  /**
   * Discards the panel at once (on Lock or erase): the chosen file's contents,
   * the preview and any approval. Late results of reads or of a restore
   * already sent are ignored. A restore the worker already committed is not
   * undone.
   */
  reset(): void;
  render(): Node | null;
}

const READ_ATTEMPTS = 3;
const PREVIEW_CASES_MAX = 200;
const PREVIEW_DETAILS_MAX = 300;

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function caseTitle(c: CaseRecord): string {
  return c.orderRef ? `Order ${c.orderRef}` : `Case with ${c.items.length} item${c.items.length === 1 ? '' : 's'}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function createRestoreController(host: RestoreHost): RestoreController {
  const { deps } = host;
  let panel: Panel | null = null;
  let fileSeq = 0;
  let destSeq = 0;
  let checkSeq = 0;
  let verifySeq = 0;

  function current(p: Panel): boolean {
    return panel === p;
  }

  /** Moves focus to the panel heading if the focused control was removed by a re-render. */
  function focusIfLost(): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body || (active instanceof HTMLButtonElement && active.disabled)) {
      document.getElementById('restore-heading')?.focus();
    }
  }

  function feedback(p: Panel, tone: Tone, text: string): void {
    p.feedback = { tone, text };
    host.announce(text);
  }

  function open(returnFocusId: string): void {
    if (panel) {
      document.getElementById('restore-heading')?.focus();
      return;
    }
    panel = {
      returnFocusId,
      phase: 'choose',
      file: null,
      error: '',
      backup: null,
      dest: { kind: 'checking' },
      destGen: 0,
      op: null,
      done: null,
      feedback: null,
    };
    host.render();
    document.getElementById('restore-heading')?.focus();
  }

  function close(): void {
    const p = panel;
    if (!p || p.phase === 'sending') return;
    // Discards the parsed file and any approval; nothing is saved.
    panel = null;
    fileSeq++;
    destSeq++;
    checkSeq++;
    host.render();
    (document.getElementById(p.returnFocusId) ?? document.getElementById('list-heading'))?.focus();
  }

  // ---- File selection and local validation ----

  async function chooseFile(file: File): Promise<void> {
    const p = panel;
    if (!p || p.op || p.phase === 'sending' || p.phase === 'uncertain' || p.phase === 'done') return;
    const seq = ++fileSeq;
    destSeq++; // any destination check for the previous file is irrelevant now
    p.file = { name: file.name, size: file.size };
    p.backup = null;
    p.error = '';
    p.feedback = null;
    p.dest = { kind: 'checking' };
    const invalid = (error: string) => {
      p.phase = 'invalid';
      p.error = error;
      host.announce(`This file cannot be restored. ${error}`);
      host.render();
    };
    if (file.size > MAX_BACKUP_BYTES) {
      invalid(`The file is ${mib(file.size)}; the largest backup this dashboard reads is ${mib(MAX_BACKUP_BYTES)} (25 MiB). The file was not read and nothing was changed.`);
      return;
    }
    if (file.size === 0) {
      invalid('The file is empty. Nothing was changed.');
      return;
    }
    p.phase = 'reading';
    host.render();
    let text: string;
    try {
      const bytes = await file.arrayBuffer();
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (err) {
      if (!current(p) || seq !== fileSeq) return;
      invalid(
        err instanceof TypeError
          ? 'The file is not UTF-8 text, so it cannot be a Refund Reconciler backup. Nothing was changed.'
          : `The browser could not read the file (${err instanceof Error ? err.name : 'error'}). Nothing was changed.`,
      );
      return;
    }
    if (!current(p) || seq !== fileSeq) return; // closed, or a newer file was chosen
    let json: unknown;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      invalid('The file is not valid JSON. Nothing was changed.');
      return;
    }
    const parsed = parseBackupEnvelope(json);
    if (!parsed.ok) {
      invalid(`${parsed.error} Nothing was changed.`);
      return;
    }
    p.backup = parsed.value;
    if (parsed.value.store.cases.length === 0) {
      p.phase = 'empty_backup';
      host.announce('This backup contains no cases, so there is nothing to restore. Nothing was changed.');
      host.render();
      return;
    }
    p.phase = 'preview';
    host.announce(`Backup checked: ${plural(parsed.value.store.cases.length, 'case')}. Checking this browser’s saved data…`);
    host.render();
    await checkDestination(p);
  }

  // ---- Destination eligibility ----

  function classify(result: LedgerState): Destination {
    switch (result.status) {
      case 'locked':
        return { kind: 'blocked', reason: 'Your records are locked. Unlock them first.' };
      case 'setup_required':
      case 'migration_required':
      case 'migration_pending':
        return { kind: 'blocked', reason: 'Your records must be protected with a passphrase first.' };
      case 'vault_unreadable':
      case 'inconsistent':
        return { kind: 'blocked', reason: 'This browser’s saved data could not be read.' };
      case 'storage_unavailable':
      case 'storage_error':
        return { kind: 'blocked', reason: `Chrome reported an error while reading this browser’s saved data (${result.error}).` };
      case 'corrupt':
        return { kind: 'blocked', reason: 'This browser’s saved data could not be read (it failed validation).' };
      case 'unsupported_version':
        return { kind: 'blocked', reason: 'This browser’s saved data uses an unsupported version.' };
      case 'ok': {
        const cases = result.store.cases;
        if (cases.length > 0) return { kind: 'not_empty', real: cases.filter((c) => !c.isDemo).length, demo: cases.filter((c) => c.isDemo).length };
        return { kind: 'eligible', expected: { revision: result.store.revision, stored: !result.isNew, epoch: result.store.ledgerEpoch ?? null } };
      }
    }
  }

  /** Fresh validated read of the destination. A read overtaken by a storage change is discarded and repeated. */
  async function checkDestination(p: Panel): Promise<void> {
    if (!current(p) || p.phase !== 'preview') return;
    const seq = ++destSeq;
    p.dest = { kind: 'checking' };
    host.render();
    let result: LedgerState;
    let gen: number;
    let superseded: boolean;
    let attempt = 0;
    do {
      attempt += 1;
      gen = host.storageGen();
      result = await deps.read();
      if (!current(p) || seq !== destSeq || p.phase !== 'preview') return;
      superseded = host.storageGen() !== gen;
    } while (superseded && attempt < READ_ATTEMPTS);
    p.destGen = gen;
    p.dest = superseded ? { kind: 'unsettled' } : classify(result);
    host.announce(
      p.dest.kind === 'eligible'
        ? 'This browser’s saved data is empty, so the backup can be restored. Nothing has been restored yet.'
        : 'Restore is not available for this browser’s saved data right now. Nothing was changed.',
    );
    host.render();
    focusIfLost();
  }

  function canApprove(p: Panel): boolean {
    return p.phase === 'preview' && p.backup !== null && p.dest.kind === 'eligible' && p.destGen === host.storageGen() && p.op === null;
  }

  // ---- Approval, sending and outcomes ----

  function approve(): void {
    const p = panel;
    if (!p || !canApprove(p) || !p.backup || p.dest.kind !== 'eligible') return;
    const op: Operation = {
      id: deps.newId(),
      backup: p.backup,
      expected: p.dest.expected,
      fileName: p.file?.name ?? 'backup',
      sentGen: host.storageGen(),
    };
    p.op = op;
    void send(p, op);
  }

  function finish(p: Panel, done: Done): void {
    p.op = null;
    p.phase = 'done';
    p.done = done;
    p.feedback = null;
    host.announce(doneText(done));
    host.render();
    document.getElementById('restore-heading')?.focus();
    // Events may have arrived while the reply was pending (or before a lost
    // reply was resolved), so establish freshness with a new read.
    void verifyCompletion(p, done);
  }

  /** Saved data is exactly what this restore wrote: its own receipt, at the revision the restore wrote. */
  function matchesRestore(store: StoreData, done: Done): boolean {
    const receipt = store.lastRestore;
    return (
      receipt !== undefined &&
      receipt.operationId === done.operationId &&
      store.revision === receipt.restoredRevision &&
      (done.revision === null || receipt.restoredRevision === done.revision)
    );
  }

  /**
   * Generation-safe freshness read for a completed restore. A mismatch is
   * final (every later write changes the revision or removes the receipt). A
   * match counts only if no storage change overtook the read; otherwise it is
   * read again. A failed read leaves the completion intact but unverified.
   */
  async function verifyCompletion(p: Panel, done: Done): Promise<void> {
    if (done.freshness === 'changed') return;
    const seq = ++verifySeq;
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      const gen = host.storageGen();
      const result = await deps.read();
      if (!current(p) || p.done !== done || seq !== verifySeq || (done.freshness as CompletionFreshness) === 'changed') return;
      if (result.status === 'ok' && !matchesRestore(result.store, done)) {
        done.freshness = 'changed';
        host.announce('Saved data has changed since this restore, so it may no longer match the backup file.');
        host.render();
        return;
      }
      if (result.status !== 'ok') {
        done.freshness = 'unverified';
        host.render();
        return;
      }
      if (host.storageGen() === gen) {
        done.freshness = 'current';
        host.render();
        return;
      }
      // Overtaken by a storage change: this match says nothing about now.
    }
    done.freshness = 'unverified';
    host.render();
  }

  async function send(p: Panel, op: Operation): Promise<void> {
    p.phase = 'sending';
    p.feedback = null;
    op.sentGen = host.storageGen();
    host.announce('Restoring…');
    host.render();
    focusIfLost();
    const res = await deps.send({ kind: 'restore', operationId: op.id, expected: op.expected, backup: op.backup });
    // Bound to this exact operation: a later file choice or panel cannot receive its result.
    if (!current(p) || p.op !== op) return;
    const caseCount = op.backup.store.cases.length;
    if (res.ok) {
      if (res.outcome === 'unchanged') {
        p.op = null;
        p.phase = 'empty_backup';
        host.render();
        return;
      }
      finish(p, {
        outcome: res.outcome === 'duplicate' ? 'duplicate' : 'applied',
        fileName: op.fileName,
        caseCount,
        operationId: op.id,
        // For a duplicate the reply carries the current revision, not the restore's.
        revision: res.outcome === 'duplicate' ? null : res.revision,
        freshness: 'checking',
      });
      return;
    }
    if (res.error.code === 'outcome_unknown') {
      p.phase = 'uncertain';
      feedback(p, 'error', 'The extension’s reply was lost, so it is not yet known whether this restore was saved. Checking saved data for this restore’s operation id…');
      host.render();
      focusIfLost();
      await recheckUncertain(p, op);
      return;
    }
    // Definitely not written: the preview stays; restoring again needs a new, explicit approval.
    p.op = null;
    p.phase = 'preview';
    const destinationMoved = res.error.code === 'restore_not_empty' || res.error.code === 'restore_stale';
    feedback(
      p,
      'error',
      destinationMoved
        ? `Not restored. ${res.error.message}`
        : `Not restored: ${res.error.message} Your saved data was not changed. The preview is kept so you can try again.`,
    );
    await checkDestination(p);
  }

  /**
   * Looks for this operation's own receipt in saved data. Never infers success
   * from case counts or matching contents. Returns once the state is known or
   * still uncertain.
   */
  async function recheckUncertain(p: Panel, op: Operation): Promise<'done' | 'absent' | 'withdrawn' | 'unreadable' | 'superseded'> {
    const seq = ++checkSeq;
    const result = await deps.read();
    if (!current(p) || p.op !== op || p.phase !== 'uncertain' || seq !== checkSeq) return 'superseded';
    if (result.status === 'ok' && result.store.lastRestore?.operationId === op.id) {
      const receipt = result.store.lastRestore;
      finish(p, {
        outcome: 'recovered',
        fileName: op.fileName,
        caseCount: receipt.caseCount,
        operationId: op.id,
        revision: receipt.restoredRevision,
        freshness: 'checking',
      });
      return 'done';
    }
    if (result.status === 'ok') {
      if (host.storageGen() === op.sentGen) {
        feedback(
          p,
          'error',
          'Could not confirm this restore: it is not in your saved data right now, but its outcome is still unknown. Nothing else has changed since it was sent. Retrying is safe: it resends exactly this approved restore with the same operation id, so it cannot be applied twice or over newer changes.',
        );
        host.render();
        return 'absent';
      }
      // Saved data changed after the request was sent and this restore is not
      // in it. It may never have been applied, or it may have been applied and
      // then deleted or erased. Either way it must not be sent again.
      p.op = null;
      p.phase = 'preview';
      feedback(
        p,
        'error',
        'Could not confirm this restore, and saved data changed after it was sent (another view may have changed, deleted or erased data). It is not in your saved data now. To avoid bringing back deleted records or writing over newer changes, this approval was withdrawn and nothing was resent. Check the destination below; restoring needs a new, explicit approval.',
      );
      await checkDestination(p);
      return 'withdrawn';
    }
    feedback(
      p,
      'error',
      'Could not confirm whether this restore was saved, and saved data cannot be read right now. Its outcome is unknown. “Check and retry restore” re-checks saved data first and only resends exactly this approved restore (same operation id) when that is safe.',
    );
    host.render();
    return 'unreadable';
  }

  async function retryUncertain(): Promise<void> {
    const p = panel;
    const op = p?.op;
    if (!p || !op || p.phase !== 'uncertain') return;
    const state = await recheckUncertain(p, op);
    if (!current(p) || p.op !== op || p.phase !== 'uncertain') return;
    if (state === 'absent' || (state === 'unreadable' && host.storageGen() === op.sentGen)) {
      // No storage change since sending: resend the identical operation. The
      // worker recognises it by its receipt if it was committed meanwhile.
      await send(p, op);
    } else if (state === 'unreadable') {
      feedback(
        p,
        'error',
        'Saved data cannot be read, and it changed after this restore was sent, so the restore was not resent. Its outcome is still unknown. Try again when saved data can be read.',
      );
      host.render();
    }
  }


  function onStorageChange(): void {
    const p = panel;
    if (!p) return;
    switch (p.phase) {
      case 'preview':
        // Pause approval at event time, before any revalidation read.
        if (p.op === null) {
          p.dest = { kind: 'checking' };
          host.announce('Saved data changed. Restore is paused while this browser’s saved data is checked again.');
          host.render();
          void checkDestination(p);
        }
        break;
      case 'uncertain':
        if (p.op) void recheckUncertain(p, p.op);
        break;
      case 'done': {
        const done = p.done;
        if (done && done.freshness !== 'changed') {
          // At event time: no longer known to match until a new read says so.
          done.freshness = 'checking';
          host.render();
          void verifyCompletion(p, done);
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- Rendering ----

  function doneText(done: Done): string {
    const what = `${plural(done.caseCount, 'case')} from ${done.fileName}`;
    switch (done.outcome) {
      case 'applied':
        return `Restore complete: ${what} were restored into this browser (saved-data revision ${done.revision}).`;
      case 'duplicate':
        return `This restore of ${what} was already completed earlier; nothing was added twice.`;
      case 'recovered':
        return `Restore complete: the extension’s reply was lost, but this restore’s own operation id is in your saved data, so ${what} were restored (saved-data revision ${done.revision}). It was not applied twice.`;
    }
  }

  function renderCompletionFreshness(done: Done): Node {
    switch (done.freshness) {
      case 'changed':
        return h(
          'p',
          { class: 'notice notice-info', 'data-testid': 'restore-changed-since', 'data-freshness': 'changed' },
          'Saved data has changed since this restore, so it may no longer match the backup file.',
        );
      case 'unverified':
        return h(
          'p',
          { class: 'notice notice-info', 'data-testid': 'restore-freshness', 'data-freshness': 'unverified' },
          'The restore was saved, but current saved data could not be verified (it could not be read, or kept changing), so it is not known whether it still matches the backup file.',
        );
      case 'checking':
        return h('p', { class: 'muted small', 'data-testid': 'restore-freshness', 'data-freshness': 'checking' }, 'Checking whether current saved data still matches this restore…');
      case 'current':
        return h('p', { class: 'muted small', 'data-testid': 'restore-freshness', 'data-freshness': 'current' }, 'Current saved data still matches this restore.');
    }
  }

  function renderDestination(p: Panel): Node {
    const d = p.dest;
    let text: string;
    let tone: Tone;
    switch (d.kind) {
      case 'checking':
        text = 'Checking this browser’s saved data… Restore is paused until the check finishes.';
        tone = 'info';
        break;
      case 'eligible':
        text = `This browser’s saved data is empty (revision ${d.expected.revision}), so this backup can be restored. Nothing has been restored yet.`;
        tone = 'success';
        break;
      case 'not_empty':
        text = `Restore is blocked: this browser already has ${plural(d.real, 'case')} of your own and ${plural(d.demo, 'synthetic demo case')}. Restore only writes into an empty ledger; it never merges with, replaces or deletes existing cases. If you really want to replace them, delete them yourself first (each case’s Delete case…, and Remove synthetic demo), then check again.`;
        tone = 'error';
        break;
      case 'blocked':
        text = `Restore is blocked: ${d.reason} Restore never treats unreadable data as empty and never repairs, resets or overwrites it.`;
        tone = 'error';
        break;
      case 'unsettled':
        text = 'Saved data kept changing while it was being checked, so restore is paused. Check again when nothing else is changing it.';
        tone = 'error';
        break;
    }
    return h('p', { class: `notice notice-${tone}`, 'data-testid': 'restore-destination', 'data-state': d.kind, role: tone === 'error' ? 'alert' : null }, text);
  }

  function renderCaseList(store: StoreData): Node {
    const shown = store.cases.slice(0, PREVIEW_CASES_MAX);
    return h(
      'div',
      {},
      h('h3', {}, 'Cases in this file'),
      h(
        'ul',
        { class: 'restore-cases', 'data-testid': 'restore-cases' },
        ...shown.map((c) =>
          h(
            'li',
            { 'data-testid': 'restore-case' },
            c.isDemo ? h('span', { class: 'badge badge-demo' }, 'Synthetic demo') : null,
            c.isDemo ? ' ' : null,
            h('strong', {}, caseTitle(c)),
            ` — ${c.items.map((i) => i.label).join(' · ')}`,
            h('span', { class: 'muted small' }, ` (${plural(c.entries.length, 'entry')}, created ${formatTimestamp(c.createdAt)})`),
          ),
        ),
      ),
      store.cases.length > shown.length ? h('p', { class: 'muted small' }, `…and ${store.cases.length - shown.length} more.`) : null,
    );
  }

  function renderPrivateDetails(store: StoreData): Node {
    const rows: Node[] = [];
    let total = 0;
    for (const c of store.cases) {
      for (const e of c.entries) {
        const parts: string[] = [];
        if (e.note) parts.push(`${e.kind === 'void' ? 'Reason' : 'Note'}: ${e.note}`);
        if ('reference' in e && e.reference) parts.push(`Ref: ${e.reference}`);
        const excerpt = e.kind === 'merchant_report' && e.capture ? e.capture : null;
        if (parts.length === 0 && !excerpt) continue;
        total += 1;
        if (rows.length >= PREVIEW_DETAILS_MAX) continue;
        const amount = 'amountCents' in e && e.amountCents !== null ? ` ${formatUsd(e.amountCents)}` : '';
        rows.push(
          h(
            'li',
            {},
            h('span', { class: 'muted small' }, `${caseTitle(c)} · ${KIND_LABEL[e.kind]}${amount}`),
            ...parts.map((t) => h('div', {}, t)),
            excerpt
              ? h(
                  'div',
                  {},
                  `Captured from ${excerpt.sourceOrigin}${excerpt.sourcePath ?? ''} (parser ${excerpt.parserVersion}, shown as stored):`,
                  h('pre', { class: 'excerpt' }, excerpt.excerpt),
                )
              : null,
          ),
        );
      }
    }
    return h(
      'details',
      { 'data-testid': 'restore-private' },
      h('summary', {}, `Show notes, references and captured excerpts in this file (${total})`),
      rows.length === 0 ? h('p', { class: 'muted small' }, 'None.') : h('ul', { class: 'restore-details' }, ...rows),
      total > rows.length ? h('p', { class: 'muted small' }, `…and ${total - rows.length} more.`) : null,
    );
  }

  function renderPreview(p: Panel, backup: ParsedBackup): (Node | null)[] {
    const n = countBackup(backup.store);
    const locked = p.op !== null;
    return [
      h(
        'dl',
        { class: 'summary', 'data-testid': 'restore-counts' },
        h('div', {}, h('dt', {}, 'Exported'), h('dd', { 'data-testid': 'restore-exported' }, formatTimestamp(backup.exportedAt))),
        h('div', {}, h('dt', {}, 'Format'), h('dd', {}, `Backup format ${backup.formatVersion} · ledger schema ${backup.store.schemaVersion} · source revision ${backup.store.revision}`)),
        h('div', {}, h('dt', {}, 'Your cases'), h('dd', { 'data-testid': 'restore-real-count' }, String(n.realCases))),
        h('div', {}, h('dt', {}, 'Synthetic demo cases'), h('dd', { 'data-testid': 'restore-demo-count' }, String(n.demoCases))),
        h('div', {}, h('dt', {}, 'Items'), h('dd', { 'data-testid': 'restore-item-count' }, String(n.items))),
        h('div', {}, h('dt', {}, 'Entries (incl. voids)'), h('dd', { 'data-testid': 'restore-entry-count' }, `${n.entries} (${plural(n.voids, 'void')})`)),
        h('div', {}, h('dt', {}, 'Captured merchant reports'), h('dd', { 'data-testid': 'restore-capture-count' }, String(n.capturedReports))),
      ),
      n.demoCases > 0
        ? h('p', { class: 'badge badge-demo', 'data-testid': 'restore-demo-note' }, `Includes ${plural(n.demoCases, 'synthetic demo case')}; they stay marked as synthetic demo data.`)
        : null,
      renderCaseList(backup.store),
      h(
        'p',
        { class: 'muted small' },
        'Every case, item and entry is restored exactly as saved in the file — including notes, references, captured excerpts, voided entries and expected-amount history, with their original IDs and recorded times. Records keep their original attribution (your own entries, or merchant statements captured from selected page text). Restoring is not verification that any money was received.',
      ),
      h(
        'p',
        { class: 'muted small' },
        'The file is an ordinary, unencrypted file and is not signed by Amazon or by this extension. The checks above confirm only that it is a well-formed backup, not who made it or whether it was edited.',
      ),
      renderPrivateDetails(backup.store),
      renderDestination(p),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          { type: 'button', id: 'restore-approve', class: 'primary', disabled: !canApprove(p), on: { click: approve } },
          `Restore ${plural(backup.store.cases.length, 'case')}`,
        ),
        p.dest.kind !== 'checking' && p.dest.kind !== 'eligible' && !locked
          ? h('button', { type: 'button', id: 'restore-recheck', on: { click: () => void checkDestination(p) } }, 'Check again')
          : null,
        h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Cancel'),
      ),
    ];
  }

  function renderFileInput(p: Panel): Node {
    const locked = p.phase === 'sending' || p.phase === 'uncertain' || p.phase === 'done' || p.op !== null;
    return h(
      'div',
      { class: 'field' },
      h('label', { for: 'restore-file' }, 'Backup file (.json)'),
      h('input', {
        id: 'restore-file',
        type: 'file',
        accept: 'application/json,.json',
        disabled: locked,
        'aria-describedby': 'restore-file-hint',
        on: {
          change: (ev) => {
            const input = ev.target as HTMLInputElement;
            const file = input.files?.[0];
            if (file) void chooseFile(file);
          },
        },
      }),
      h(
        'span',
        { class: 'muted small', id: 'restore-file-hint' },
        `A file downloaded with “Download all data (JSON)”, up to ${mib(MAX_BACKUP_BYTES)}. Choosing a file only reads and checks it; nothing is saved until you choose Restore.`,
      ),
      p.file ? h('p', { class: 'small', 'data-testid': 'restore-file-name' }, 'Selected file: ', h('span', { class: 'literal' }, p.file.name), ` (${mib(p.file.size)})`) : null,
    );
  }

  function render(): Node | null {
    const p = panel;
    if (!p) return null;
    const body: (Node | null)[] = [];
    if (p.phase !== 'done') {
      body.push(
        h(
          'p',
          {},
          'Restore a JSON backup into this browser. It only works when this browser has no saved cases (not even synthetic demo cases), and it never merges with, replaces or deletes existing data.',
        ),
        renderFileInput(p),
      );
    }
    switch (p.phase) {
      case 'choose':
        body.push(h('div', { class: 'actions' }, h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Cancel')));
        break;
      case 'reading':
        body.push(h('p', { class: 'muted' }, 'Reading and checking the file…'), h('div', { class: 'actions' }, h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Cancel')));
        break;
      case 'invalid':
        body.push(
          h('div', { class: 'notice notice-error', role: 'alert', 'data-testid': 'restore-invalid' }, h('p', {}, 'This file cannot be restored.'), h('p', { class: 'literal' }, p.error)),
          h('div', { class: 'actions' }, h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Cancel')),
        );
        break;
      case 'empty_backup':
        body.push(
          h('p', { class: 'notice notice-info', 'data-testid': 'restore-empty-backup' }, 'This backup is valid but contains no cases, so there is nothing to restore. Nothing was changed.'),
          h('div', { class: 'actions' }, h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Close')),
        );
        break;
      case 'preview':
        if (p.backup) body.push(...renderPreview(p, p.backup));
        break;
      case 'sending':
        body.push(h('p', { class: 'notice notice-info', 'data-testid': 'restore-sending' }, `Restoring ${p.op?.fileName ?? ''}… Please wait.`));
        break;
      case 'uncertain':
        body.push(
          h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', id: 'restore-retry', class: 'primary', on: { click: () => void retryUncertain() } }, 'Check and retry restore'),
            h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Close'),
          ),
          h('p', { class: 'muted small' }, 'Closing discards this approved restore; its outcome stays unknown until you check your saved data.'),
        );
        break;
      case 'done': {
        const done = p.done;
        if (done) {
          body.push(
            h('p', { class: 'notice notice-success', 'data-testid': 'restore-done', 'data-outcome': done.outcome }, doneText(done)),
            renderCompletionFreshness(done),
            h('p', { class: 'muted small' }, 'Restored records keep their original sources and recorded times. Restoring is not verification that any money was received.'),
            h('div', { class: 'actions' }, h('button', { type: 'button', id: 'restore-cancel', on: { click: close } }, 'Close')),
          );
        }
        break;
      }
    }
    if (p.feedback && p.phase !== 'done') {
      body.push(
        h('p', { class: `notice notice-${p.feedback.tone}`, role: p.feedback.tone === 'error' ? 'alert' : null, 'data-testid': 'restore-feedback' }, p.feedback.text),
      );
    }
    return h(
      'section',
      {
        class: 'panel restore-panel',
        'aria-labelledby': 'restore-heading',
        'data-testid': 'restore-panel',
        'data-phase': p.phase,
        on: {
          keydown: (ev) => {
            if (ev.key === 'Escape' && p.phase !== 'sending') {
              ev.preventDefault();
              close();
            }
          },
        },
      },
      h('h2', { id: 'restore-heading', tabindex: -1 }, 'Restore from JSON backup'),
      ...body,
    );
  }

  function reset(): void {
    panel = null;
    fileSeq++;
    destSeq++;
    checkSeq++;
    verifySeq++;
  }

  return { open, isOpen: () => panel !== null, onStorageChange, render, reset };
}
