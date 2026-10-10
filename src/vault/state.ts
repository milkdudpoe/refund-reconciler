// What a page is told about the ledger. The service worker decides the state;
// pages render it and never decrypt anything themselves. Only the `ok` state
// carries ledger data.

import type { StoreData } from '../domain/types';
import { isId, parseStore } from '../domain/validate';

export type LedgerState =
  /** Unlocked: the decrypted, validated ledger. `isNew` is always false for a vault (it always exists once set up). */
  | { readonly status: 'ok'; readonly store: StoreData; readonly isNew: false; readonly vaultId: string }
  /** No ledger of any kind: "Protect your records" must be completed first. `erased` after an explicit erase. */
  | { readonly status: 'setup_required'; readonly erased: boolean }
  /**
   * Valid plaintext records from an earlier version must be encrypted first.
   * legacy: never started. interrupted: an earlier attempt did not write an
   * encrypted copy. candidate_unreadable: an earlier attempt left an encrypted
   * copy that cannot be read. The plaintext original is intact in all three.
   */
  | { readonly status: 'migration_required'; readonly stage: 'legacy' | 'interrupted' | 'candidate_unreadable'; readonly legacyCases: number }
  /** An encrypted copy exists beside the intact original; unlocking verifies it and finishes. */
  | { readonly status: 'migration_pending'; readonly stage: 'candidate' | 'verified'; readonly legacyCases: number }
  | { readonly status: 'locked' }
  /** The vault itself cannot be read. Nothing is reset; erase is the only way forward. */
  | { readonly status: 'vault_unreadable'; readonly reason: 'corrupt' | 'unsupported' | 'payload_invalid' | 'payload_unsupported'; readonly detail: string }
  /** Stored records disagree with each other in a way this build will not resolve on its own. */
  | { readonly status: 'inconsistent'; readonly detail: string; readonly legacyReadable: boolean }
  /** Plaintext records from an earlier version that fail validation (kept intact, shown read-only). */
  | { readonly status: 'corrupt'; readonly error: string; readonly raw: unknown }
  | { readonly status: 'unsupported_version'; readonly version: unknown; readonly raw: unknown }
  /** A storage read failed. Says nothing about what is stored. */
  | { readonly status: 'storage_error'; readonly error: string }
  /** Storage could not be restricted to this extension's own pages, so nothing is read, written or unlocked. */
  | { readonly status: 'storage_unavailable'; readonly error: string };

export type LedgerStatus = LedgerState['status'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): v is string => typeof v === 'string';
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Runtime validation of a state received from the service worker. An `ok`
 * ledger is re-validated with parseStore(), so a page never renders a ledger
 * that would not pass domain validation. Anything unexpected is null.
 */
export function parseLedgerState(v: unknown): LedgerState | null {
  if (!isRecord(v)) return null;
  switch (v.status) {
    case 'ok': {
      if (v.isNew !== false || !isId(v.vaultId)) return null;
      const parsed = parseStore(v.store);
      return parsed.status === 'ok' ? { status: 'ok', store: parsed.store, isNew: false, vaultId: v.vaultId } : null;
    }
    case 'setup_required':
      return typeof v.erased === 'boolean' ? { status: 'setup_required', erased: v.erased } : null;
    case 'migration_required':
      return (v.stage === 'legacy' || v.stage === 'interrupted' || v.stage === 'candidate_unreadable') && count(v.legacyCases)
        ? { status: 'migration_required', stage: v.stage, legacyCases: v.legacyCases }
        : null;
    case 'migration_pending':
      return (v.stage === 'candidate' || v.stage === 'verified') && count(v.legacyCases) ? { status: 'migration_pending', stage: v.stage, legacyCases: v.legacyCases } : null;
    case 'locked':
      return { status: 'locked' };
    case 'vault_unreadable':
      return (v.reason === 'corrupt' || v.reason === 'unsupported' || v.reason === 'payload_invalid' || v.reason === 'payload_unsupported') && str(v.detail)
        ? { status: 'vault_unreadable', reason: v.reason, detail: v.detail }
        : null;
    case 'inconsistent':
      return str(v.detail) && typeof v.legacyReadable === 'boolean' ? { status: 'inconsistent', detail: v.detail, legacyReadable: v.legacyReadable } : null;
    case 'corrupt':
      return str(v.error) ? { status: 'corrupt', error: v.error, raw: v.raw } : null;
    case 'unsupported_version':
      return { status: 'unsupported_version', version: v.version, raw: v.raw };
    case 'storage_error':
      return str(v.error) ? { status: 'storage_error', error: v.error } : null;
    case 'storage_unavailable':
      return str(v.error) ? { status: 'storage_unavailable', error: v.error } : null;
    default:
      return null;
  }
}

/** States in which the plaintext records from an earlier version can be downloaded as a backup. */
export function legacyBackupAvailable(s: LedgerState): boolean {
  return s.status === 'migration_required' || s.status === 'migration_pending' || (s.status === 'inconsistent' && s.legacyReadable);
}
