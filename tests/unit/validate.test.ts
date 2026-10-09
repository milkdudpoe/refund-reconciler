import { describe, expect, it } from 'vitest';
import { parseCommand, parseStore } from '../../src/domain/validate';
import { parseRequest } from '../../src/background/messages';
import { Harness } from './helpers';

function populated() {
  const h = new Harness();
  h.createCase('c', [{ id: 'a', expected: 3500 }, { id: 'b', expected: null }], '123-4567');
  h.record('c', { id: 'r', kind: 'receipt', itemId: 'a', amountCents: 3500, reference: 'T1', occurredOn: '2026-01-02' });
  h.record('c', { id: 'm', kind: 'merchant_report', itemId: 'b', amountCents: 1000 });
  h.must({ type: 'voidEntry', caseId: 'c', voidEntryId: 'v', targetEntryId: 'm', reason: 'Wrong item' });
  return h.store;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('parseStore', () => {
  it('accepts data written by the ledger after a JSON round trip', () => {
    const store = populated();
    expect(parseStore(clone(store))).toEqual({ status: 'ok', store });
  });

  it('reports an unsupported schema version instead of guessing', () => {
    expect(parseStore({ schemaVersion: 2, revision: 1, cases: [] })).toEqual({ status: 'unsupported_version', version: 2 });
    expect(parseStore({ revision: 1, cases: [] })).toMatchObject({ status: 'unsupported_version' });
  });

  it.each<[string, (s: Record<string, any>) => void]>([
    ['float cents', (s) => { s.cases[0].entries[2].amountCents = 35.5; }],
    ['negative cents', (s) => { s.cases[0].entries[2].amountCents = -1; }],
    ['unsafe cents', (s) => { s.cases[0].entries[2].amountCents = 2 ** 60; }],
    ['string cents', (s) => { s.cases[0].entries[2].amountCents = '35'; }],
    ['zero receipt', (s) => { s.cases[0].entries[2].amountCents = 0; }],
    ['unknown kind', (s) => { s.cases[0].entries[2].kind = 'refund'; }],
    ['unknown item', (s) => { s.cases[0].entries[2].itemId = 'zzz'; }],
    ['bad date', (s) => { s.cases[0].entries[2].occurredOn = '2026-02-30'; }],
    ['extra field', (s) => { s.cases[0].extra = 1; }],
    ['wrong currency', (s) => { s.cases[0].currency = 'EUR'; }],
    ['duplicate entry ids', (s) => { s.cases[0].entries[2].id = s.cases[0].entries[1].id; }],
    ['dangling void', (s) => { s.cases[0].entries[4].targetEntryId = 'nope'; }],
    ['cases not a list', (s) => { s.cases = {}; }],
    ['no items', (s) => { s.cases[0].items = []; }],
  ])('rejects corrupt data: %s', (_name, mutate) => {
    const raw = clone(populated()) as unknown as Record<string, any>;
    mutate(raw);
    expect(parseStore(raw).status).toBe('corrupt');
  });

  it('rejects non-objects', () => {
    expect(parseStore('hello').status).toBe('corrupt');
    expect(parseStore(null).status).toBe('corrupt');
  });
});

describe('parseCommand / parseRequest', () => {
  const entry = { id: 'e1', kind: 'receipt', itemId: 'a', amountCents: 100, occurredOn: null, source: 'Manual', note: '', reference: null };

  it('accepts a well-formed command', () => {
    expect(parseCommand({ type: 'recordEntry', caseId: 'c', entry }).ok).toBe(true);
  });

  it.each([
    ['negative amount', { ...entry, amountCents: -100 }],
    ['float amount', { ...entry, amountCents: 1.5 }],
    ['unsafe amount', { ...entry, amountCents: Number.MAX_SAFE_INTEGER + 2 }],
    ['zero receipt', { ...entry, amountCents: 0 }],
    ['null receipt', { ...entry, amountCents: null }],
    ['bad id', { ...entry, id: '<script>' }],
    ['empty source', { ...entry, source: '  ' }],
    ['too long note', { ...entry, note: 'x'.repeat(1001) }],
    ['extra field', { ...entry, sneaky: true }],
    ['void kind smuggled in', { ...entry, kind: 'void' }],
  ])('rejects %s', (_name, bad) => {
    expect(parseCommand({ type: 'recordEntry', caseId: 'c', entry: bad }).ok).toBe(false);
  });

  it('rejects unknown message shapes and unconfirmed erase', () => {
    expect(parseRequest(null).ok).toBe(false);
    expect(parseRequest({ kind: 'mutate', command: { type: 'dropTables' } }).ok).toBe(false);
    expect(parseRequest({ kind: 'eraseAll' }).ok).toBe(false);
    expect(parseRequest({ kind: 'eraseAll', confirm: 'yes' }).ok).toBe(false);
  });

  it('requires at least one item when creating a case', () => {
    expect(parseCommand({ type: 'createCase', caseId: 'c', orderRef: null, items: [] }).ok).toBe(false);
  });
});
