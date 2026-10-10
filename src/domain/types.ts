import type { Cents } from './money';

export const SCHEMA_VERSION = 1;

export type Retailer = 'amazon_us';
export type Currency = 'USD';

export interface ItemRecord {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
}

interface EntryBase {
  /** Ingestion key. Re-submitting the same id with the same contents is a no-op. */
  readonly id: string;
  readonly itemId: string;
  /** When the entry was written to storage (ISO 8601, assigned by the service worker). */
  readonly recordedAt: string;
  /** Optional user-supplied date the event happened (YYYY-MM-DD). */
  readonly occurredOn: string | null;
  /** Where the evidence came from, e.g. "Manual entry" or "Synthetic demo". */
  readonly source: string;
  readonly note: string;
}

/** User-approved expected refund for an item. `null` means unknown — never zero. */
export interface ExpectationEntry extends EntryBase {
  readonly kind: 'expectation';
  readonly amountCents: Cents | null;
}

/**
 * Merchant says a refund was issued. A dated snapshot of the merchant's reported
 * total for the item — not money received, and never summed with other reports.
 */
export interface MerchantReportEntry extends EntryBase {
  readonly kind: 'merchant_report';
  readonly amountCents: Cents;
  readonly reference: string | null;
  /**
   * Present only when the report came from user-approved selected page text.
   * Absent on manual entries (including all Task 01 data). It explains where
   * the merchant's statement was read; it is never proof that money arrived.
   */
  readonly capture?: CaptureProvenance;
}

export type CaptureOrigin = 'https://www.amazon.com' | 'https://amazon.com';

/** Where and how a captured merchant report was read. Stored with the entry. */
export interface CaptureProvenance {
  /** Page origin the selection was read from (checked at extraction time). */
  readonly sourceOrigin: CaptureOrigin;
  /** Path with tracking segments, fragments and non-order query parameters removed; null if not kept. */
  readonly sourcePath: string | null;
  /** When the selection was read (ISO 8601, extension clock). */
  readonly capturedAt: string;
  /** The normalised excerpt the user saw and approved. */
  readonly excerpt: string;
  /** Version of the deterministic excerpt parser that proposed the amount. */
  readonly parserVersion: string;
  /** The literal amount text in the excerpt that the user approved, e.g. "$70.00". */
  readonly approvedAmountText: string;
  /** The single order reference found in the excerpt, if any. */
  readonly detectedOrderRef: string | null;
  /** The user confirmed the reported total applies to this one item. Always true when stored. */
  readonly itemApplicabilityConfirmed: true;
}

/** The user explicitly confirms money arrived for this item. */
export interface ReceiptEntry extends EntryBase {
  readonly kind: 'receipt';
  readonly amountCents: Cents;
  readonly reference: string | null;
}

/** The user records money taken back (re-charged) for this item. */
export interface RechargeEntry extends EntryBase {
  readonly kind: 'recharge';
  readonly amountCents: Cents;
  readonly reference: string | null;
}

/** Marks an earlier entry as mistaken. The original entry is kept unchanged. */
export interface VoidEntry extends EntryBase {
  readonly kind: 'void';
  readonly targetEntryId: string;
}

export type EvidenceEntry = MerchantReportEntry | ReceiptEntry | RechargeEntry;
export type Entry = ExpectationEntry | EvidenceEntry | VoidEntry;
export type EntryKind = Entry['kind'];
export const VOIDABLE_KINDS: readonly EntryKind[] = ['merchant_report', 'receipt', 'recharge'];

export interface CaseRecord {
  readonly id: string;
  readonly retailer: Retailer;
  readonly orderRef: string | null;
  readonly currency: Currency;
  /** Synthetic demo data, shown separately from real cases. */
  readonly isDemo: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly ItemRecord[];
  /** Append-only evidence log in recording order. */
  readonly entries: readonly Entry[];
}

/**
 * Bookkeeping written by a restore from a backup file, in the SAME stored
 * record as the restored cases, so a committed restore can always be
 * recognised by its operation id (even after a lost reply or a service worker
 * restart). Optional: absent on every ledger that was never restored, so all
 * existing schema-1 data and Task 03 backup files stay valid. Only the most
 * recent restore is kept. A receipt inside an imported backup is source
 * metadata from another ledger and is never carried into the destination.
 */
export interface RestoreReceipt {
  /** Id of the approved restore operation (generated per approval by the dashboard). */
  readonly operationId: string;
  /** SHA-256 (hex) of the approved payload; reusing the id with different contents is a conflict. */
  readonly payloadSha256: string;
  /** When the restore was committed (ISO 8601, service worker clock). */
  readonly restoredAt: string;
  /** Destination revision assigned by the restore write. */
  readonly restoredRevision: number;
  /** The backup's exportedAt (source metadata). */
  readonly sourceExportedAt: string;
  /** The backup ledger's own revision (source metadata; never applied to the destination counter). */
  readonly sourceRevision: number;
  /** Number of cases the restore wrote. */
  readonly caseCount: number;
}

export interface StoreData {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  /** Incremented on every successful write. */
  readonly revision: number;
  readonly cases: readonly CaseRecord[];
  /** Present only after a restore from a backup file (see RestoreReceipt). */
  readonly lastRestore?: RestoreReceipt;
  /**
   * Opaque random marker written by an explicit erase (a new value on every
   * erase) and carried unchanged through every later write. It holds no user
   * data; it only lets the service worker tell an erased ledger apart from the
   * ledger an earlier restore approval was made against. Absent on ledgers
   * that were never erased.
   */
  readonly ledgerEpoch?: string;
}

/** What an explicit erase leaves in storage: no cases, no receipt, only a new marker. */
export function erasedStore(ledgerEpoch: string): StoreData {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, cases: [], ledgerEpoch };
}

export function emptyStore(): StoreData {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, cases: [] };
}

// ---- Commands (the only way the store changes) ----

export interface NewItemInput {
  readonly itemId: string;
  readonly label: string;
  readonly expectedCents: Cents | null;
  readonly expectationEntryId: string;
}

export interface CreateCaseCommand {
  readonly type: 'createCase';
  readonly caseId: string;
  readonly orderRef: string | null;
  readonly items: readonly NewItemInput[];
}

export interface RecordEntryCommand {
  readonly type: 'recordEntry';
  readonly caseId: string;
  readonly entry: {
    readonly id: string;
    readonly kind: 'expectation' | 'merchant_report' | 'receipt' | 'recharge';
    readonly itemId: string;
    readonly amountCents: Cents | null;
    readonly occurredOn: string | null;
    readonly source: string;
    readonly note: string;
    readonly reference: string | null;
    /** Only for merchant reports captured from selected page text. */
    readonly capture?: CaptureProvenance;
  };
}

export interface VoidEntryCommand {
  readonly type: 'voidEntry';
  readonly caseId: string;
  readonly voidEntryId: string;
  readonly targetEntryId: string;
  readonly reason: string;
}

export interface DeleteCaseCommand {
  readonly type: 'deleteCase';
  readonly caseId: string;
}

export interface LoadDemoCommand {
  readonly type: 'loadDemo';
}

export interface RemoveDemoCommand {
  readonly type: 'removeDemo';
}

export type Command =
  | CreateCaseCommand
  | RecordEntryCommand
  | VoidEntryCommand
  | DeleteCaseCommand
  | LoadDemoCommand
  | RemoveDemoCommand;

export type CommandErrorCode =
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'already_voided'
  | 'not_voidable';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export type ApplyOutcome = 'applied' | 'duplicate' | 'unchanged';

export type ApplyResult =
  | { readonly ok: true; readonly outcome: ApplyOutcome; readonly store: StoreData }
  | { readonly ok: false; readonly error: CommandError };
