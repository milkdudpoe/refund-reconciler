// Pure restore of a validated backup into an EMPTY destination ledger. Never
// merges, replaces or deletes existing cases, never replays entries as new
// commands, and never touches storage. The service worker applies the result
// in one write together with its receipt.

import type { ParsedBackup } from './validate';
import { SCHEMA_VERSION, type StoreData } from './types';

/** What the dashboard saw when the restore was approved. */
export interface RestoreExpectation {
  /** Destination revision at approval. */
  readonly revision: number;
  /** Whether the ledger key existed at approval (false for a never-written profile). */
  readonly stored: boolean;
  /** The destination's `ledgerEpoch` at approval (null if it had none). Every erase changes it. */
  readonly epoch: string | null;
}

export interface RestoreRequest {
  readonly operationId: string;
  readonly expected: RestoreExpectation;
  readonly backup: ParsedBackup;
}

export type RestoreDecision =
  | { readonly kind: 'write'; readonly store: StoreData }
  /** This exact operation is already committed (its receipt is in the destination). Nothing to write. */
  | { readonly kind: 'already_restored'; readonly revision: number }
  /** The backup has no cases: nothing to restore, nothing written. */
  | { readonly kind: 'empty_backup'; readonly revision: number }
  | { readonly kind: 'refused'; readonly code: 'conflict' | 'restore_not_empty' | 'restore_stale'; readonly message: string };

/**
 * Decides a restore against the destination as read immediately before
 * writing. `destStored` is false when the ledger key does not exist.
 */
export function decideRestore(dest: StoreData, destStored: boolean, req: RestoreRequest, payloadSha256: string, now: string): RestoreDecision {
  const receipt = dest.lastRestore;
  if (receipt && receipt.operationId === req.operationId) {
    return receipt.payloadSha256 === payloadSha256
      ? { kind: 'already_restored', revision: dest.revision }
      : { kind: 'refused', code: 'conflict', message: 'This restore operation id was already used for a different backup. Nothing was changed.' };
  }
  if (req.backup.store.cases.length === 0) return { kind: 'empty_backup', revision: dest.revision };
  if (dest.cases.length > 0) {
    return {
      kind: 'refused',
      code: 'restore_not_empty',
      message: `Saved data now contains ${dest.cases.length} case${dest.cases.length === 1 ? '' : 's'}, so nothing was restored. Restore only writes into an empty ledger and never merges with, replaces or deletes existing cases.`,
    };
  }
  // The erase marker makes this token unrepeatable across erases: an erase
  // always writes a new epoch, so no approval made before it can match after it.
  if (dest.revision !== req.expected.revision || destStored !== req.expected.stored || (dest.ledgerEpoch ?? null) !== req.expected.epoch) {
    return {
      kind: 'refused',
      code: 'restore_stale',
      message: 'Saved data changed after this restore was approved, so nothing was restored. Check the destination again and approve the restore again.',
    };
  }
  const revision = dest.revision + 1;
  return {
    kind: 'write',
    store: {
      schemaVersion: SCHEMA_VERSION,
      // The destination's own marker; a marker inside the backup is never imported.
      ...(dest.ledgerEpoch === undefined ? {} : { ledgerEpoch: dest.ledgerEpoch }),
      revision,
      // Cases, items and entries exactly as validated: original ids, timestamps,
      // order, amounts, notes, references, voids, demo flags and provenance.
      cases: req.backup.store.cases,
      lastRestore: {
        operationId: req.operationId,
        payloadSha256,
        restoredAt: now,
        restoredRevision: revision,
        sourceExportedAt: req.backup.exportedAt,
        sourceRevision: req.backup.store.revision,
        caseCount: req.backup.store.cases.length,
      },
    },
  };
}
