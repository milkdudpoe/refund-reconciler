// Pure state transitions. Every change to stored data goes through
// applyCommand(), which never mutates its input and never touches storage.

import { buildDemoCases } from './demo';
import {
  VOIDABLE_KINDS,
  type ApplyResult,
  type CaseRecord,
  type Command,
  type CreateCaseCommand,
  type Entry,
  type RecordEntryCommand,
  type StoreData,
  type VoidEntryCommand,
} from './types';
import { currentExpectation } from './reconcile';
import { PARSER_VERSION, analyzeExcerpt } from '../capture/parse';
import { assessOrder, orderContextOf } from '../capture/order';
import { orderFromSourcePath } from '../capture/source';

const MANUAL_SOURCE = 'Manual entry';

function err(code: Extract<ApplyResult, { ok: false }>['error']['code'], message: string): ApplyResult {
  return { ok: false, error: { code, message } };
}

function commit(store: StoreData, cases: readonly CaseRecord[]): ApplyResult {
  return { ok: true, outcome: 'applied', store: { ...store, revision: store.revision + 1, cases } };
}

function unchanged(store: StoreData, outcome: 'duplicate' | 'unchanged'): ApplyResult {
  return { ok: true, outcome, store };
}

function replaceCase(store: StoreData, updated: CaseRecord): readonly CaseRecord[] {
  return store.cases.map((c) => (c.id === updated.id ? updated : c));
}

function findEntry(store: StoreData, entryId: string): { caseRecord: CaseRecord; entry: Entry } | null {
  for (const c of store.cases) {
    const entry = c.entries.find((e) => e.id === entryId);
    if (entry) return { caseRecord: c, entry };
  }
  return null;
}

export function voidedEntryIds(caseRecord: CaseRecord): ReadonlySet<string> {
  return new Set(caseRecord.entries.flatMap((e) => (e.kind === 'void' ? [e.targetEntryId] : [])));
}

/** The contents that define an entry's identity for idempotency (excludes recordedAt). */
function fingerprint(caseId: string, e: Omit<Entry, 'recordedAt'> | RecordEntryCommand['entry']): string {
  const amount = 'amountCents' in e ? e.amountCents : undefined;
  const reference = 'reference' in e ? e.reference : undefined;
  const target = 'targetEntryId' in e ? e.targetEntryId : undefined;
  const c = 'capture' in e ? e.capture : undefined;
  // Provenance is part of identity: reusing a capture id with a different
  // excerpt, source or time is a conflict, never a silent overwrite.
  const capture = c
    ? [c.sourceOrigin, c.sourcePath, c.capturedAt, c.excerpt, c.parserVersion, c.approvedAmountText, c.detectedOrderRef, c.itemApplicabilityConfirmed]
    : null;
  return JSON.stringify([caseId, e.kind, e.itemId, amount, e.occurredOn, e.source, e.note, reference ?? null, target ?? null, capture]);
}

/**
 * Re-checks a captured merchant report against the pure parser before it is
 * stored, so only an unambiguous, item-applicable issued amount from the
 * approved excerpt can be saved, and never into a demo case or a case for a
 * different known order.
 */
function checkCapture(caseRecord: CaseRecord, input: RecordEntryCommand['entry']): ApplyResult | null {
  const capture = input.capture;
  if (!capture) return null;
  if (caseRecord.isDemo) return err('invalid', 'Captured evidence cannot be saved to a synthetic demo case. Choose one of your own cases.');
  if (input.kind !== 'merchant_report') return err('invalid', 'Only merchant reports can be captured.');
  if (capture.parserVersion !== PARSER_VERSION) return err('invalid', 'This capture was read by a different parser version. Capture the text again.');
  const analysis = analyzeExcerpt(capture.excerpt);
  const expectedOrder = analysis.orderRef.status === 'found' ? analysis.orderRef.value : null;
  const expectedDate = analysis.date.status === 'found' ? analysis.date.value : null;
  if (
    analysis.excerpt !== capture.excerpt ||
    analysis.issued === null ||
    analysis.issued.cents !== input.amountCents ||
    analysis.issued.amountText !== capture.approvedAmountText ||
    expectedOrder !== capture.detectedOrderRef ||
    expectedDate !== input.occurredOn
  ) {
    return err('invalid', 'The captured excerpt does not support exactly this issued amount. Nothing was saved.');
  }
  // Same rule as the popup: the excerpt's order and the source page's order
  // (kept in sourcePath) must not contradict each other or the chosen case.
  const order = assessOrder(
    orderContextOf(capture.detectedOrderRef === null ? [] : [capture.detectedOrderRef]),
    orderFromSourcePath(capture.sourcePath),
    caseRecord.orderRef,
  );
  if (!order.ok) {
    return err(
      'invalid',
      order.block === 'case_mismatch'
        ? 'The captured page or text names a different order than this case. Nothing was saved.'
        : 'The captured page and text name conflicting orders. Nothing was saved.',
    );
  }
  return null;
}

function createCase(store: StoreData, cmd: CreateCaseCommand, now: string, isDemo = false, source = MANUAL_SOURCE): ApplyResult {
  const itemIds = new Set(cmd.items.map((i) => i.itemId));
  const entryIds = new Set(cmd.items.map((i) => i.expectationEntryId));
  if (itemIds.size !== cmd.items.length) return err('invalid', 'Item ids must be unique.');
  if (entryIds.size !== cmd.items.length) return err('invalid', 'Entry ids must be unique.');

  const caseRecord: CaseRecord = {
    id: cmd.caseId,
    retailer: 'amazon_us',
    orderRef: cmd.orderRef,
    currency: 'USD',
    isDemo,
    createdAt: now,
    updatedAt: now,
    items: cmd.items.map((i) => ({ id: i.itemId, label: i.label, createdAt: now })),
    entries: cmd.items.map((i) => ({
      id: i.expectationEntryId,
      kind: 'expectation',
      itemId: i.itemId,
      amountCents: i.expectedCents,
      recordedAt: now,
      occurredOn: null,
      source,
      note: 'Initial expected refund',
    })),
  };

  const existing = store.cases.find((c) => c.id === cmd.caseId);
  if (existing) {
    const same =
      existing.orderRef === caseRecord.orderRef &&
      existing.isDemo === isDemo &&
      JSON.stringify(existing.items.map((i) => [i.id, i.label])) === JSON.stringify(caseRecord.items.map((i) => [i.id, i.label])) &&
      caseRecord.entries.every((e) => {
        const prior = existing.entries.find((p) => p.id === e.id);
        return prior !== undefined && fingerprint(existing.id, prior) === fingerprint(existing.id, e);
      });
    return same ? unchanged(store, 'duplicate') : err('conflict', 'A different case already uses this id.');
  }
  for (const e of caseRecord.entries) {
    if (findEntry(store, e.id)) return err('conflict', `Entry id ${e.id} is already used.`);
  }
  return commit(store, [...store.cases, caseRecord]);
}

function recordEntry(store: StoreData, cmd: RecordEntryCommand, now: string): ApplyResult {
  const caseRecord = store.cases.find((c) => c.id === cmd.caseId);
  if (!caseRecord) return err('not_found', 'That case no longer exists.');
  const input = cmd.entry;
  if (!caseRecord.items.some((i) => i.id === input.itemId)) {
    return err('not_found', 'That item does not belong to this case.');
  }
  if (input.kind !== 'expectation' && input.amountCents === null) {
    return err('invalid', 'An amount is required.');
  }
  if (input.kind === 'receipt' || input.kind === 'recharge') {
    if (input.amountCents === 0) return err('invalid', 'Amount must be greater than zero.');
  }

  // Same ingestion id: identical contents are a no-op, anything else is a conflict.
  const prior = findEntry(store, input.id);
  if (prior) {
    return fingerprint(prior.caseRecord.id, prior.entry) === fingerprint(cmd.caseId, input)
      ? unchanged(store, 'duplicate')
      : err('conflict', 'This entry id was already recorded with different details. Nothing was overwritten.');
  }
  const captureProblem = checkCapture(caseRecord, input);
  if (captureProblem) return captureProblem;

  // Same external transaction/observation reference among active entries of the same kind.
  if (input.reference !== null && input.kind !== 'expectation') {
    for (const c of store.cases) {
      const voided = voidedEntryIds(c);
      for (const e of c.entries) {
        if (e.kind !== input.kind || voided.has(e.id) || e.reference !== input.reference) continue;
        return fingerprint(c.id, { ...e, id: input.id }) === fingerprint(cmd.caseId, input)
          ? unchanged(store, 'duplicate')
          : err('conflict', `Reference "${input.reference}" is already recorded with different details. Nothing was overwritten.`);
      }
    }
  }

  let entry: Entry;
  if (input.kind === 'expectation') {
    if (currentExpectation(caseRecord, input.itemId) === input.amountCents) return unchanged(store, 'unchanged');
    entry = { id: input.id, kind: 'expectation', itemId: input.itemId, amountCents: input.amountCents, recordedAt: now, occurredOn: input.occurredOn, source: input.source, note: input.note };
  } else {
    const evidence = { id: input.id, kind: input.kind, itemId: input.itemId, amountCents: input.amountCents ?? 0, recordedAt: now, occurredOn: input.occurredOn, source: input.source, note: input.note, reference: input.reference };
    entry = evidence.kind === 'merchant_report' && input.capture ? { ...evidence, kind: 'merchant_report', capture: input.capture } : evidence;
  }
  return commit(store, replaceCase(store, { ...caseRecord, updatedAt: now, entries: [...caseRecord.entries, entry] }));
}

function voidEntry(store: StoreData, cmd: VoidEntryCommand, now: string): ApplyResult {
  const caseRecord = store.cases.find((c) => c.id === cmd.caseId);
  if (!caseRecord) return err('not_found', 'That case no longer exists.');
  const existingVoid = findEntry(store, cmd.voidEntryId);
  if (existingVoid) {
    const e = existingVoid.entry;
    return e.kind === 'void' && e.targetEntryId === cmd.targetEntryId && existingVoid.caseRecord.id === cmd.caseId && e.note === cmd.reason
      ? unchanged(store, 'duplicate')
      : err('conflict', 'This void id was already used for something else.');
  }
  const target = caseRecord.entries.find((e) => e.id === cmd.targetEntryId);
  if (!target) return err('not_found', 'That entry does not exist in this case.');
  if (!VOIDABLE_KINDS.includes(target.kind)) {
    return err('not_voidable', 'Only merchant reports, receipts and recharges can be voided. Edit the expected amount instead.');
  }
  if (voidedEntryIds(caseRecord).has(target.id)) return err('already_voided', 'That entry is already voided.');
  const entry: Entry = {
    id: cmd.voidEntryId,
    kind: 'void',
    itemId: target.itemId,
    targetEntryId: target.id,
    recordedAt: now,
    occurredOn: null,
    source: MANUAL_SOURCE,
    note: cmd.reason,
  };
  return commit(store, replaceCase(store, { ...caseRecord, updatedAt: now, entries: [...caseRecord.entries, entry] }));
}

export function applyCommand(store: StoreData, cmd: Command, now: string): ApplyResult {
  switch (cmd.type) {
    case 'createCase':
      return createCase(store, cmd, now);
    case 'recordEntry':
      return recordEntry(store, cmd, now);
    case 'voidEntry':
      return voidEntry(store, cmd, now);
    case 'deleteCase': {
      if (!store.cases.some((c) => c.id === cmd.caseId)) return unchanged(store, 'unchanged');
      return commit(store, store.cases.filter((c) => c.id !== cmd.caseId));
    }
    case 'loadDemo': {
      if (store.cases.some((c) => c.isDemo)) return unchanged(store, 'unchanged');
      let next = store;
      for (const demo of buildDemoCases()) {
        const created = createCase(next, demo.create, now, true, 'Synthetic demo');
        if (!created.ok) return created;
        next = created.store;
        for (const entry of demo.entries) {
          const recorded = recordEntry(next, { type: 'recordEntry', caseId: demo.create.caseId, entry }, now);
          if (!recorded.ok) return recorded;
          next = recorded.store;
        }
      }
      return { ok: true, outcome: 'applied', store: { ...next, revision: store.revision + 1 } };
    }
    case 'removeDemo': {
      if (!store.cases.some((c) => c.isDemo)) return unchanged(store, 'unchanged');
      return commit(store, store.cases.filter((c) => !c.isDemo));
    }
  }
}
