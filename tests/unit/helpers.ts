import { applyCommand } from '../../src/domain/ledger';
import { emptyStore, type CaseRecord, type Command, type RecordEntryCommand, type StoreData } from '../../src/domain/types';

/** Applies commands in order with a deterministic clock, failing loudly on errors. */
export class Harness {
  store: StoreData = emptyStore();
  private tick = 0;

  now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }

  apply(cmd: Command) {
    const result = applyCommand(this.store, cmd, this.now());
    if (result.ok) this.store = result.store;
    return result;
  }

  must(cmd: Command): void {
    const result = this.apply(cmd);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  }

  createCase(caseId: string, items: { id: string; label?: string; expected: number | null }[], orderRef: string | null = null): void {
    this.must({
      type: 'createCase',
      caseId,
      orderRef,
      items: items.map((i) => ({ itemId: i.id, label: i.label ?? `Item ${i.id}`, expectedCents: i.expected, expectationEntryId: `exp-${caseId}-${i.id}` })),
    });
  }

  record(caseId: string, entry: Partial<RecordEntryCommand['entry']> & Pick<RecordEntryCommand['entry'], 'id' | 'kind' | 'itemId'>) {
    return this.apply({
      type: 'recordEntry',
      caseId,
      entry: { amountCents: null, occurredOn: null, source: 'Test', note: '', reference: null, ...entry },
    });
  }

  case(caseId: string): CaseRecord {
    const c = this.store.cases.find((x) => x.id === caseId);
    if (!c) throw new Error(`no case ${caseId}`);
    return c;
  }
}
