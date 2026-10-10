// Pure portable-backup and filename generation. The backup wraps the validated
// store unchanged in a small versioned envelope; nothing is recomputed,
// formatted or dropped.

import type { StoreData } from '../domain/types';

export const BACKUP_FORMAT = 'refund-reconciler-backup';
/** Version of the envelope below. Independent of the ledger's schemaVersion. */
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupEnvelope {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: typeof BACKUP_FORMAT_VERSION;
  /** When the snapshot inside was read from storage (ISO 8601). */
  readonly exportedAt: string;
  /** The validated store exactly as read: every case, item and entry, including voids and expectation history. */
  readonly store: StoreData;
}

/**
 * Largest backup file the dashboard will read for restore (25 MiB). Checked
 * from the file's size before any of it is read. The ledger itself lives in
 * chrome.storage.local, whose quota (10 MB without unlimitedStorage) may still
 * reject a restore of a very large file; that is reported as a rejected write.
 */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

export function buildBackup(store: StoreData, exportedAt: string): BackupEnvelope {
  return { format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, exportedAt, store };
}

export function serializeBackup(backup: BackupEnvelope): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export interface BackupCounts {
  readonly realCases: number;
  readonly demoCases: number;
  readonly items: number;
  readonly entries: number;
  readonly voids: number;
  readonly capturedReports: number;
}

export function countBackup(store: StoreData): BackupCounts {
  const entries = store.cases.flatMap((c) => c.entries);
  return {
    realCases: store.cases.filter((c) => !c.isDemo).length,
    demoCases: store.cases.filter((c) => c.isDemo).length,
    items: store.cases.reduce((n, c) => n + c.items.length, 0),
    entries: entries.length,
    voids: entries.filter((e) => e.kind === 'void').length,
    capturedReports: entries.filter((e) => e.kind === 'merchant_report' && e.capture !== undefined).length,
  };
}

export type ExportKind = 'case-summary' | 'backup';

const PREFIX: Record<ExportKind, string> = {
  'case-summary': 'refund-reconciler-case-summary',
  backup: 'refund-reconciler-backup',
};
const EXTENSION: Record<ExportKind, string> = { 'case-summary': 'txt', backup: 'json' };

/**
 * A constant prefix plus a UTC timestamp, e.g.
 * "refund-reconciler-backup-2026-10-10T120501Z.json". Never derived from case
 * labels, order references or any other stored text.
 */
export function exportFilename(kind: ExportKind, takenAt: string): string {
  const d = new Date(takenAt);
  const stamp = Number.isNaN(d.getTime()) ? 'undated' : `${d.toISOString().slice(0, 19).replaceAll(':', '')}Z`;
  return `${PREFIX[kind]}-${stamp}.${EXTENSION[kind]}`;
}

/**
 * The identity of a restore payload: SHA-256 over the canonical JSON of the
 * validated cases plus the backup's exportedAt. A restore operation id reused
 * with a different payload is a conflict. Source revision and any imported
 * restore receipt are deliberately excluded (they are never restored).
 */
export async function restorePayloadDigest(exportedAt: string, store: StoreData): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([exportedAt, store.cases]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
