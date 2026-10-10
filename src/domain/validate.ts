// Runtime validation for anything that crosses a trust boundary: data read from
// chrome.storage.local and messages sent to the service worker. TypeScript
// types alone are not trusted here.

import { MAX_INPUT_CENTS, isCents, parseMoney } from './money';
import { SUPPORTED_ORIGINS, isValidSourcePath } from '../capture/source';
import { KNOWN_PARSER_VERSIONS } from '../capture/parse';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION } from '../export/backup';
import {
  SCHEMA_VERSION,
  type CaptureProvenance,
  type CaseRecord,
  type Command,
  type Entry,
  type ItemRecord,
  type NewItemInput,
  type RestoreReceipt,
  type StoreData,
} from './types';

export const LIMITS = {
  idMax: 64,
  labelMax: 200,
  noteMax: 1000,
  sourceMax: 100,
  referenceMax: 100,
  orderRefMax: 100,
  reasonMax: 500,
  itemsPerCase: 50,
  excerptMax: 4000,
  amountTextMax: 32,
  parserVersionMax: 40,
} as const;

/** Source recorded on every merchant report captured from selected page text. */
export const CAPTURE_SOURCE = 'Amazon page selection (captured)';

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

class ValidationError extends Error {}

function fail(path: string, problem: string): never {
  throw new ValidationError(`${path}: ${problem}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) fail(path, 'expected an object');
  return v;
}

function exactKeys(o: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) fail(`${path}.${k}`, 'unexpected field');
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= LIMITS.idMax && ID_PATTERN.test(v);
}

function id(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.idMax || !ID_PATTERN.test(v)) {
    fail(path, 'expected an id');
  }
  return v;
}

function text(v: unknown, path: string, max: number, opts: { allowEmpty: boolean }): string {
  if (typeof v !== 'string') fail(path, 'expected text');
  if (v.length > max) fail(path, `longer than ${max} characters`);
  if (!opts.allowEmpty && v.trim() === '') fail(path, 'must not be empty');
  return v;
}

function nullableText(v: unknown, path: string, max: number): string | null {
  if (v === null) return null;
  const t = text(v, path, max, { allowEmpty: false });
  return t;
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && ISO_PATTERN.test(v) && !Number.isNaN(Date.parse(v));
}

function isoTimestamp(v: unknown, path: string): string {
  if (!isIsoTimestamp(v)) {
    fail(path, 'expected an ISO timestamp');
  }
  return v;
}

export function isValidCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function nullableDate(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (typeof v !== 'string' || !isValidCalendarDate(v)) fail(path, 'expected a YYYY-MM-DD date');
  return v;
}

function cents(v: unknown, path: string, opts: { positive: boolean }): number {
  if (!isCents(v) || v > MAX_INPUT_CENTS) fail(path, 'expected a non-negative safe integer cent amount');
  if (opts.positive && v === 0) fail(path, 'must be greater than zero');
  return v;
}

function nullableCents(v: unknown, path: string): number | null {
  return v === null ? null : cents(v, path, { positive: false });
}

function literal<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(path, `expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected a list');
  return v;
}

// ---- Capture provenance (optional on merchant reports) ----

const PROVENANCE_KEYS = ['sourceOrigin', 'sourcePath', 'capturedAt', 'excerpt', 'parserVersion', 'approvedAmountText', 'detectedOrderRef', 'itemApplicabilityConfirmed'];

/**
 * Validates provenance and ties it to its entry: the approved amount text must
 * appear in the excerpt and parse to exactly the entry's amount.
 */
function parseProvenance(v: unknown, path: string, amountCents: number, source: string): CaptureProvenance {
  const o = obj(v, path);
  exactKeys(o, PROVENANCE_KEYS, path);
  for (const k of PROVENANCE_KEYS) if (!(k in o)) fail(`${path}.${k}`, 'missing');
  const sourceOrigin = literal(o.sourceOrigin, SUPPORTED_ORIGINS, `${path}.sourceOrigin`);
  const sourcePath = o.sourcePath === null ? null : text(o.sourcePath, `${path}.sourcePath`, 300, { allowEmpty: false });
  if (sourcePath !== null && !isValidSourcePath(sourcePath)) fail(`${path}.sourcePath`, 'expected a sanitised path');
  const excerpt = text(o.excerpt, `${path}.excerpt`, LIMITS.excerptMax, { allowEmpty: false });
  const approvedAmountText = text(o.approvedAmountText, `${path}.approvedAmountText`, LIMITS.amountTextMax, { allowEmpty: false });
  const approved = parseMoney(approvedAmountText.replace(/^US\$/, '$').replace(/^\$\s/, '$'));
  if (!approved.ok || approved.cents !== amountCents) fail(`${path}.approvedAmountText`, 'does not match the entry amount');
  if (!excerpt.includes(approvedAmountText)) fail(`${path}.approvedAmountText`, 'not found in the excerpt');
  if (o.itemApplicabilityConfirmed !== true) fail(`${path}.itemApplicabilityConfirmed`, 'must be true');
  if (source !== CAPTURE_SOURCE) fail(`${path}`, 'captured reports use the capture source label');
  return {
    sourceOrigin,
    sourcePath,
    capturedAt: isoTimestamp(o.capturedAt, `${path}.capturedAt`),
    excerpt,
    parserVersion: text(o.parserVersion, `${path}.parserVersion`, LIMITS.parserVersionMax, { allowEmpty: false }),
    approvedAmountText,
    detectedOrderRef: nullableText(o.detectedOrderRef, `${path}.detectedOrderRef`, LIMITS.orderRefMax),
    itemApplicabilityConfirmed: true,
  };
}

// ---- Stored data ----

function parseItem(v: unknown, path: string): ItemRecord {
  const o = obj(v, path);
  exactKeys(o, ['id', 'label', 'createdAt'], path);
  return {
    id: id(o.id, `${path}.id`),
    label: text(o.label, `${path}.label`, LIMITS.labelMax, { allowEmpty: false }),
    createdAt: isoTimestamp(o.createdAt, `${path}.createdAt`),
  };
}

const ENTRY_BASE_KEYS = ['id', 'kind', 'itemId', 'recordedAt', 'occurredOn', 'source', 'note'];

function parseEntry(v: unknown, path: string): Entry {
  const o = obj(v, path);
  const kind = literal(o.kind, ['expectation', 'merchant_report', 'receipt', 'recharge', 'void'], `${path}.kind`);
  const base = {
    id: id(o.id, `${path}.id`),
    itemId: id(o.itemId, `${path}.itemId`),
    recordedAt: isoTimestamp(o.recordedAt, `${path}.recordedAt`),
    occurredOn: nullableDate(o.occurredOn, `${path}.occurredOn`),
    source: text(o.source, `${path}.source`, LIMITS.sourceMax, { allowEmpty: false }),
    note: text(o.note, `${path}.note`, LIMITS.noteMax, { allowEmpty: true }),
  };
  switch (kind) {
    case 'expectation':
      exactKeys(o, [...ENTRY_BASE_KEYS, 'amountCents'], path);
      return { ...base, kind, amountCents: nullableCents(o.amountCents, `${path}.amountCents`) };
    case 'merchant_report': {
      // `capture` is optional, so entries written before capture existed stay valid.
      exactKeys(o, [...ENTRY_BASE_KEYS, 'amountCents', 'reference', 'capture'], path);
      const amountCents = cents(o.amountCents, `${path}.amountCents`, { positive: false });
      const entry = { ...base, kind, amountCents, reference: nullableText(o.reference, `${path}.reference`, LIMITS.referenceMax) };
      return 'capture' in o ? { ...entry, capture: parseProvenance(o.capture, `${path}.capture`, amountCents, base.source) } : entry;
    }
    case 'receipt':
    case 'recharge':
      exactKeys(o, [...ENTRY_BASE_KEYS, 'amountCents', 'reference'], path);
      return {
        ...base,
        kind,
        amountCents: cents(o.amountCents, `${path}.amountCents`, { positive: true }),
        reference: nullableText(o.reference, `${path}.reference`, LIMITS.referenceMax),
      };
    case 'void':
      exactKeys(o, [...ENTRY_BASE_KEYS, 'targetEntryId'], path);
      if (base.note.trim() === '') fail(`${path}.note`, 'a void needs a reason');
      return { ...base, kind, targetEntryId: id(o.targetEntryId, `${path}.targetEntryId`) };
  }
}

function parseCase(v: unknown, path: string): CaseRecord {
  const o = obj(v, path);
  exactKeys(o, ['id', 'retailer', 'orderRef', 'currency', 'isDemo', 'createdAt', 'updatedAt', 'items', 'entries'], path);
  if (typeof o.isDemo !== 'boolean') fail(`${path}.isDemo`, 'expected true or false');
  const items = array(o.items, `${path}.items`).map((it, i) => parseItem(it, `${path}.items[${i}]`));
  if (items.length === 0 || items.length > LIMITS.itemsPerCase) fail(`${path}.items`, 'invalid item count');
  const entries = array(o.entries, `${path}.entries`).map((e, i) => parseEntry(e, `${path}.entries[${i}]`));
  const itemIds = new Set(items.map((i) => i.id));
  if (itemIds.size !== items.length) fail(`${path}.items`, 'duplicate item id');
  const entryById = new Map<string, Entry>();
  for (const [i, e] of entries.entries()) {
    if (!itemIds.has(e.itemId)) fail(`${path}.entries[${i}].itemId`, 'refers to an unknown item');
    if (entryById.has(e.id)) fail(`${path}.entries[${i}].id`, 'duplicate entry id');
    if (e.kind === 'void') {
      const target = entryById.get(e.targetEntryId);
      if (!target || target.kind === 'void' || target.kind === 'expectation' || target.itemId !== e.itemId) {
        fail(`${path}.entries[${i}].targetEntryId`, 'must refer to an earlier evidence entry on the same item');
      }
    }
    entryById.set(e.id, e);
  }
  return {
    id: id(o.id, `${path}.id`),
    retailer: literal(o.retailer, ['amazon_us'], `${path}.retailer`),
    orderRef: nullableText(o.orderRef, `${path}.orderRef`, LIMITS.orderRefMax),
    currency: literal(o.currency, ['USD'], `${path}.currency`),
    isDemo: o.isDemo,
    createdAt: isoTimestamp(o.createdAt, `${path}.createdAt`),
    updatedAt: isoTimestamp(o.updatedAt, `${path}.updatedAt`),
    items,
    entries,
  };
}

function nonNegativeInteger(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(path, 'expected a non-negative integer');
  return v;
}

const RECEIPT_KEYS = ['operationId', 'payloadSha256', 'restoredAt', 'restoredRevision', 'sourceExportedAt', 'sourceRevision', 'caseCount'];

function parseRestoreReceipt(v: unknown, path: string, revision: number): RestoreReceipt {
  const o = obj(v, path);
  exactKeys(o, RECEIPT_KEYS, path);
  for (const k of RECEIPT_KEYS) if (!(k in o)) fail(`${path}.${k}`, 'missing');
  if (typeof o.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.payloadSha256)) fail(`${path}.payloadSha256`, 'expected a SHA-256 hex digest');
  const restoredRevision = nonNegativeInteger(o.restoredRevision, `${path}.restoredRevision`);
  if (restoredRevision < 1 || restoredRevision > revision) fail(`${path}.restoredRevision`, 'must be between 1 and the store revision');
  return {
    operationId: id(o.operationId, `${path}.operationId`),
    payloadSha256: o.payloadSha256,
    restoredAt: isoTimestamp(o.restoredAt, `${path}.restoredAt`),
    restoredRevision,
    sourceExportedAt: isoTimestamp(o.sourceExportedAt, `${path}.sourceExportedAt`),
    sourceRevision: nonNegativeInteger(o.sourceRevision, `${path}.sourceRevision`),
    caseCount: nonNegativeInteger(o.caseCount, `${path}.caseCount`),
  };
}

export type StoreParse =
  | { status: 'ok'; store: StoreData }
  | { status: 'unsupported_version'; version: unknown }
  | { status: 'corrupt'; error: string };

/** Validates a raw value from storage. Never repairs or resets anything. */
export function parseStore(raw: unknown): StoreParse {
  if (!isRecord(raw)) return { status: 'corrupt', error: 'store: expected an object' };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return { status: 'unsupported_version', version: raw.schemaVersion };
  }
  try {
    // `lastRestore` is optional, so ledgers and backups written before restore existed stay valid.
    exactKeys(raw, ['schemaVersion', 'revision', 'cases', 'lastRestore'], 'store');
    const revision = nonNegativeInteger(raw.revision, 'store.revision');
    const cases = array(raw.cases, 'store.cases').map((c, i) => parseCase(c, `store.cases[${i}]`));
    const ids = new Set<string>();
    const entryIds = new Set<string>();
    for (const c of cases) {
      if (ids.has(c.id)) fail('store.cases', `duplicate case id ${c.id}`);
      ids.add(c.id);
      for (const e of c.entries) {
        if (entryIds.has(e.id)) fail('store.cases', `entry id ${e.id} used in more than one case`);
        entryIds.add(e.id);
      }
    }
    const store: StoreData = { schemaVersion: SCHEMA_VERSION, revision, cases };
    return { status: 'ok', store: 'lastRestore' in raw ? { ...store, lastRestore: parseRestoreReceipt(raw.lastRestore, 'store.lastRestore', revision) } : store };
  } catch (err) {
    if (err instanceof ValidationError) return { status: 'corrupt', error: err.message };
    throw err;
  }
}

// ---- Commands (messages from the dashboard) ----

function parseNewItem(v: unknown, path: string): NewItemInput {
  const o = obj(v, path);
  exactKeys(o, ['itemId', 'label', 'expectedCents', 'expectationEntryId'], path);
  return {
    itemId: id(o.itemId, `${path}.itemId`),
    label: text(o.label, `${path}.label`, LIMITS.labelMax, { allowEmpty: false }).trim(),
    expectedCents: nullableCents(o.expectedCents, `${path}.expectedCents`),
    expectationEntryId: id(o.expectationEntryId, `${path}.expectationEntryId`),
  };
}

function parseCommandUnsafe(v: unknown): Command {
  const o = obj(v, 'command');
  const type = literal(o.type, ['createCase', 'recordEntry', 'voidEntry', 'deleteCase', 'loadDemo', 'removeDemo'], 'command.type');
  switch (type) {
    case 'createCase': {
      exactKeys(o, ['type', 'caseId', 'orderRef', 'items'], 'command');
      const items = array(o.items, 'command.items').map((it, i) => parseNewItem(it, `command.items[${i}]`));
      if (items.length === 0) fail('command.items', 'add at least one item');
      if (items.length > LIMITS.itemsPerCase) fail('command.items', `at most ${LIMITS.itemsPerCase} items`);
      const orderRef = nullableText(o.orderRef, 'command.orderRef', LIMITS.orderRefMax);
      return { type, caseId: id(o.caseId, 'command.caseId'), orderRef: orderRef?.trim() ?? null, items };
    }
    case 'recordEntry': {
      exactKeys(o, ['type', 'caseId', 'entry'], 'command');
      const e = obj(o.entry, 'command.entry');
      exactKeys(e, ['id', 'kind', 'itemId', 'amountCents', 'occurredOn', 'source', 'note', 'reference', 'capture'], 'command.entry');
      const kind = literal(e.kind, ['expectation', 'merchant_report', 'receipt', 'recharge'], 'command.entry.kind');
      const amountCents =
        kind === 'expectation'
          ? nullableCents(e.amountCents, 'command.entry.amountCents')
          : cents(e.amountCents, 'command.entry.amountCents', { positive: kind !== 'merchant_report' });
      const reference = nullableText(e.reference, 'command.entry.reference', LIMITS.referenceMax);
      if (kind === 'expectation' && reference !== null) fail('command.entry.reference', 'not used for expectations');
      const source = text(e.source, 'command.entry.source', LIMITS.sourceMax, { allowEmpty: false }).trim();
      const entry = {
        id: id(e.id, 'command.entry.id'),
        kind,
        itemId: id(e.itemId, 'command.entry.itemId'),
        amountCents,
        occurredOn: nullableDate(e.occurredOn, 'command.entry.occurredOn'),
        source,
        note: text(e.note, 'command.entry.note', LIMITS.noteMax, { allowEmpty: true }).trim(),
        reference: reference?.trim() ?? null,
      };
      if (!('capture' in e)) return { type, caseId: id(o.caseId, 'command.caseId'), entry };
      if (kind !== 'merchant_report' || amountCents === null) fail('command.entry.capture', 'only merchant reports can carry capture provenance');
      if (entry.reference !== null) fail('command.entry.reference', 'captured reports carry no reference');
      const capture = parseProvenance(e.capture, 'command.entry.capture', amountCents, source);
      return { type, caseId: id(o.caseId, 'command.caseId'), entry: { ...entry, capture } };
    }
    case 'voidEntry':
      exactKeys(o, ['type', 'caseId', 'voidEntryId', 'targetEntryId', 'reason'], 'command');
      return {
        type,
        caseId: id(o.caseId, 'command.caseId'),
        voidEntryId: id(o.voidEntryId, 'command.voidEntryId'),
        targetEntryId: id(o.targetEntryId, 'command.targetEntryId'),
        reason: text(o.reason, 'command.reason', LIMITS.reasonMax, { allowEmpty: false }).trim(),
      };
    case 'deleteCase':
      exactKeys(o, ['type', 'caseId'], 'command');
      return { type, caseId: id(o.caseId, 'command.caseId') };
    case 'loadDemo':
    case 'removeDemo':
      exactKeys(o, ['type'], 'command');
      return { type };
  }
}

export function parseCommand(v: unknown): Validation<Command> {
  try {
    return { ok: true, value: parseCommandUnsafe(v) };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    throw err;
  }
}

// ---- Backup files (restore input) ----

/**
 * The exported backup envelope, validated for restore. `store` passes the same
 * parseStore() validator as data read from chrome.storage.local.
 */
export interface ParsedBackup {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: typeof BACKUP_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly store: StoreData;
}

/**
 * Validates an untrusted, already JSON-parsed backup file. Checks the exact
 * envelope fields, format and version, then the complete ledger. Never repairs
 * anything. Historical captures are accepted only with a known parser version
 * and are never re-parsed.
 */
export function parseBackupEnvelope(v: unknown): Validation<ParsedBackup> {
  if (!isRecord(v)) return { ok: false, error: 'This file is not a Refund Reconciler backup (expected a JSON object).' };
  if (v.format !== BACKUP_FORMAT) return { ok: false, error: 'This file is not a Refund Reconciler backup (its "format" field is missing or different).' };
  if (v.formatVersion !== BACKUP_FORMAT_VERSION) {
    return { ok: false, error: `This backup uses format version ${JSON.stringify(v.formatVersion) ?? 'missing'}; this build can restore format version ${BACKUP_FORMAT_VERSION} only.` };
  }
  const unexpected = Object.keys(v).filter((k) => !['format', 'formatVersion', 'exportedAt', 'store'].includes(k));
  if (unexpected.length > 0) return { ok: false, error: `The backup envelope has unexpected field(s): ${unexpected.slice(0, 5).join(', ')}.` };
  if (!isIsoTimestamp(v.exportedAt)) return { ok: false, error: 'The backup’s "exportedAt" is not a valid ISO timestamp.' };
  if (!('store' in v)) return { ok: false, error: 'The backup has no "store" (saved data) field.' };
  const parsed = parseStore(v.store);
  if (parsed.status === 'unsupported_version') {
    return { ok: false, error: `The saved data in this backup uses ledger schema version ${JSON.stringify(parsed.version) ?? 'missing'}; this build supports version ${SCHEMA_VERSION} only.` };
  }
  if (parsed.status === 'corrupt') return { ok: false, error: `The saved data in this backup failed validation: ${parsed.error}` };
  for (const [ci, c] of parsed.store.cases.entries()) {
    for (const [ei, e] of c.entries.entries()) {
      if (e.kind === 'merchant_report' && e.capture && !KNOWN_PARSER_VERSIONS.includes(e.capture.parserVersion)) {
        return { ok: false, error: `The saved data in this backup failed validation: store.cases[${ci}].entries[${ei}].capture.parserVersion: unknown capture parser version.` };
      }
    }
  }
  return { ok: true, value: { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, exportedAt: v.exportedAt, store: parsed.store } };
}
