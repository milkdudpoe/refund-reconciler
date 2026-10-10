// Message protocol between the extension's pages and the service worker.
// Every incoming message is validated at runtime before it is acted on, and
// pages validate every reply. Ledger data reaches a page only in a `read`
// reply while the vault is unlocked (or, before migration, in a
// `readLegacy` reply for the plaintext backup of an earlier version's data).

import type { ApplyOutcome, Command, CommandErrorCode, StoreData } from '../domain/types';
import { isId, parseBackupEnvelope, parseCommand, parseStore, type Validation } from '../domain/validate';
import type { RestoreRequest } from '../domain/restore';
import { parseLedgerState, type LedgerState } from '../vault/state';
import { PASSPHRASE_MAX_BYTES } from '../vault/passphrase';

export const ERASE_CONFIRMATION = 'ERASE ALL REFUND RECONCILER DATA';

export type Request =
  | { kind: 'mutate'; command: Command }
  /** Restore a validated backup into an empty, unlocked ledger (see src/domain/restore.ts). */
  | ({ kind: 'restore' } & RestoreRequest);

export type VaultRequest =
  | { kind: 'read' }
  /** The validated plaintext records of an earlier version, for the pre-migration backup only. */
  | { kind: 'readLegacy' }
  | { kind: 'setup'; passphrase: string; acknowledged: true }
  | { kind: 'migrate'; passphrase: string; acknowledged: true; replaceCandidate: boolean }
  | { kind: 'unlock'; passphrase: string }
  | { kind: 'lock' }
  | { kind: 'eraseAll'; confirm: typeof ERASE_CONFIRMATION };

export type AnyRequest = Request | VaultRequest;

export type ResponseErrorCode =
  | CommandErrorCode
  | 'invalid_message'
  | 'storage_unreadable'
  | 'storage_unsupported'
  /** The vault is locked (or the session that unlocked it was revoked). Nothing was written. */
  | 'vault_locked'
  /** Setup, migration or recovery must be completed first. Nothing was written. */
  | 'vault_not_ready'
  /** Restore refused: the destination has cases. Nothing was written. */
  | 'restore_not_empty'
  /** Restore refused: the destination changed since approval. Nothing was written. */
  | 'restore_stale'
  /** Reading stored data failed before any write was attempted. Nothing changed. */
  | 'storage_error'
  /** The change could not be applied before writing. Nothing was written. */
  | 'not_applied'
  /** chrome.storage rejected the write, so it was not committed. */
  | 'write_rejected'
  /**
   * Set only by a page when no valid response arrived (for example the
   * message channel failed). The write may or may not have been committed.
   */
  | 'outcome_unknown';

export type Response =
  | { ok: true; outcome: ApplyOutcome; revision: number }
  | { ok: false; error: { code: ResponseErrorCode; message: string } };

export type ReadResponse = { ok: true; ledger: LedgerState } | { ok: false; error: { code: string; message: string } };

export type LegacyReadResponse = { ok: true; store: StoreData } | { ok: false; error: { code: string; message: string } };

/**
 * unlocked: the vault is unlocked for this browser session.
 * locked: Lock now completed (or the action finished but left the vault locked).
 * protected_locked: setup or migration completed and the records are
 *   encrypted, but this session could not be unlocked; unlock to continue.
 * erased: every stored record and the session were removed.
 */
export type VaultOutcome = 'unlocked' | 'locked' | 'protected_locked' | 'erased';

export type VaultErrorCode =
  | 'invalid_message'
  /** The passphrase does not meet the documented rules. Nothing changed. */
  | 'passphrase_rejected'
  /** Wrong passphrase, or a damaged stored key: the two cannot be told apart. Nothing changed. */
  | 'unlock_failed'
  /** The request does not apply to the current stored state (re-read it). Nothing changed. */
  | 'wrong_state'
  | 'storage_error'
  | 'storage_unavailable'
  /** chrome.storage.session could not be used, so the key was not kept anywhere. */
  | 'session_unavailable'
  /** A write was rejected before anything was committed. */
  | 'write_rejected'
  /** Not enough room for the encrypted copy beside the original. Nothing was written. */
  | 'insufficient_space'
  /** The key unlocked but the encrypted records are unreadable. Nothing was changed or reset. */
  | 'vault_unreadable'
  /** An encrypted copy may have been written but could not be verified. The original is intact. */
  | 'migration_unverified'
  /** The encrypted copy does not match the original. Neither was changed or preferred. */
  | 'migration_blocked'
  /** The encrypted copy is verified but the plaintext original could not be removed yet. */
  | 'migration_incomplete'
  /** Records were removed but the new erase marker could not be written. */
  | 'erase_incomplete'
  /** Chrome refused to clear the session record. */
  | 'lock_incomplete'
  | 'outcome_unknown';

export type VaultResponse = { ok: true; outcome: VaultOutcome; message: string } | { ok: false; error: { code: VaultErrorCode; message: string } };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function onlyKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o);
}

/** Cheap shape check; the service worker applies the full passphrase rules itself. */
function isPassphraseField(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= PASSPHRASE_MAX_BYTES;
}

export function parseRequest(raw: unknown): Validation<AnyRequest> {
  if (!isRecord(raw)) return { ok: false, error: 'message: expected an object' };
  const o = raw;
  switch (o.kind) {
    case 'mutate': {
      if (Object.keys(o).some((k) => k !== 'kind' && k !== 'command')) return { ok: false, error: 'message: unexpected field' };
      const cmd = parseCommand(o.command);
      return cmd.ok ? { ok: true, value: { kind: 'mutate', command: cmd.value } } : cmd;
    }
    case 'restore':
      return parseRestoreRequest(o);
    case 'eraseAll':
      if (o.confirm !== ERASE_CONFIRMATION || Object.keys(o).length !== 2) return { ok: false, error: 'message: erase requires explicit confirmation' };
      return { ok: true, value: { kind: 'eraseAll', confirm: ERASE_CONFIRMATION } };
    case 'read':
    case 'readLegacy':
    case 'lock':
      return Object.keys(o).length === 1 ? { ok: true, value: { kind: o.kind } } : { ok: false, error: 'message: unexpected field' };
    case 'setup':
      if (!onlyKeys(o, ['kind', 'passphrase', 'acknowledged']) || !isPassphraseField(o.passphrase) || o.acknowledged !== true) {
        return { ok: false, error: 'message: setup requires a passphrase and the recovery acknowledgment' };
      }
      return { ok: true, value: { kind: 'setup', passphrase: o.passphrase, acknowledged: true } };
    case 'migrate':
      if (!onlyKeys(o, ['kind', 'passphrase', 'acknowledged', 'replaceCandidate']) || !isPassphraseField(o.passphrase) || o.acknowledged !== true || typeof o.replaceCandidate !== 'boolean') {
        return { ok: false, error: 'message: migration requires a passphrase and the recovery acknowledgment' };
      }
      return { ok: true, value: { kind: 'migrate', passphrase: o.passphrase, acknowledged: true, replaceCandidate: o.replaceCandidate } };
    case 'unlock':
      if (!onlyKeys(o, ['kind', 'passphrase']) || !isPassphraseField(o.passphrase)) return { ok: false, error: 'message: unlock requires a passphrase' };
      return { ok: true, value: { kind: 'unlock', passphrase: o.passphrase } };
    default:
      return { ok: false, error: 'message: unknown kind' };
  }
}

function parseRestoreRequest(o: Record<string, unknown>): Validation<AnyRequest> {
  if (Object.keys(o).some((k) => !['kind', 'operationId', 'expected', 'backup'].includes(k))) return { ok: false, error: 'message: unexpected field' };
  if (!isId(o.operationId)) return { ok: false, error: 'message.operationId: expected an id' };
  const e = o.expected;
  if (
    typeof e !== 'object' || e === null || Array.isArray(e) ||
    Object.keys(e).length !== 3 ||
    typeof (e as Record<string, unknown>).stored !== 'boolean' ||
    !((e as Record<string, unknown>).epoch === null || isId((e as Record<string, unknown>).epoch)) ||
    !Number.isSafeInteger((e as Record<string, unknown>).revision) ||
    ((e as Record<string, unknown>).revision as number) < 0
  ) {
    return { ok: false, error: 'message.expected: expected { revision, stored, epoch }' };
  }
  const backup = parseBackupEnvelope(o.backup);
  if (!backup.ok) return { ok: false, error: `message.backup: ${backup.error}` };
  const expected = e as { revision: number; stored: boolean; epoch: string | null };
  return {
    ok: true,
    value: { kind: 'restore', operationId: o.operationId, expected: { revision: expected.revision, stored: expected.stored, epoch: expected.epoch }, backup: backup.value },
  };
}

function isErrorReply(v: Record<string, unknown>): boolean {
  const e = v.error;
  return v.ok === false && isRecord(e) && typeof e.code === 'string' && typeof e.message === 'string';
}

export function isResponse(v: unknown): v is Response {
  if (!isRecord(v)) return false;
  if (v.ok === true) return (v.outcome === 'applied' || v.outcome === 'duplicate' || v.outcome === 'unchanged') && Number.isSafeInteger(v.revision);
  return isErrorReply(v);
}

export function parseReadResponse(v: unknown): ReadResponse | null {
  if (!isRecord(v)) return null;
  if (v.ok === true) {
    const ledger = parseLedgerState(v.ledger);
    return ledger ? { ok: true, ledger } : null;
  }
  return isErrorReply(v) ? (v as ReadResponse) : null;
}

export function parseLegacyReadResponse(v: unknown): LegacyReadResponse | null {
  if (!isRecord(v)) return null;
  if (v.ok === true) {
    const parsed = parseStore(v.store);
    return parsed.status === 'ok' ? { ok: true, store: parsed.store } : null;
  }
  return isErrorReply(v) ? (v as LegacyReadResponse) : null;
}

export function isVaultResponse(v: unknown): v is VaultResponse {
  if (!isRecord(v)) return false;
  if (v.ok === true) return (v.outcome === 'unlocked' || v.outcome === 'locked' || v.outcome === 'protected_locked' || v.outcome === 'erased') && typeof v.message === 'string';
  return isErrorReply(v);
}
