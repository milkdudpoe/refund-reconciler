// The service worker's trusted boundary. Every request (reads included) runs
// through one queue, one at a time in arrival order, so:
//
// - each change applies to the latest saved ledger, never a page's copy;
// - setup, migration, unlock, Lock and erase never interleave with each other
//   or with reads and writes. A request queued before Lock completes as
//   normal (an approved write that commits before Lock finishes is not undone);
//   every request queued after Lock finds the vault locked.
//
// The ledger is decrypted here only, with a data key held in this worker's
// memory and, for suspension recovery, in chrome.storage.session. Pages never
// receive key material. See docs/vault.md for the states and failure rules.
//
// Consent gate (docs/consent.md): before any request that reads, unlocks,
// sets up, migrates or changes records, the worker reads only the nonprivate
// consent receipt. Unless it is a valid receipt for the current
// DATA_PRACTICES_VERSION, the request is refused before any key derivation,
// decryption, ledger read or write. Lock, the typed erase and the agreement
// itself are the only actions available without it.

import { applyCommand } from '../domain/ledger';
import { decideRestore } from '../domain/restore';
import { SCHEMA_VERSION, type StoreData } from '../domain/types';
import { isId, parseStore } from '../domain/validate';
import { restorePayloadDigest } from '../export/backup';
import { DATA_PRACTICES_VERSION } from '../consent/practices';
import { makeReceipt, parseConsent } from '../consent/receipt';
import {
  CONSENT_KEY,
  ERASE_KEY,
  GENERATION_KEY,
  LEDGER_KEYS,
  LEGACY_STORE_KEY,
  MIGRATION_KEY,
  SESSION_KEY,
  VAULT_KEY,
  describeError,
  type StorageAreaLike,
} from '../persistence/storage';
import { createVault, deriveWrappingKey, exportRawKey, importRawKey, openPayload, sealPayload, unwrapDataKey } from '../vault/crypto';
import {
  ERASE_FORMAT,
  MIGRATION_FORMAT,
  SESSION_FORMAT,
  base64ToBytes,
  parseEnvelope,
  parseEraseMarker,
  parseMigrationMarker,
  parseSessionRecord,
  type EraseMarker,
  type MigrationMarker,
  type VaultEnvelope,
} from '../vault/format';
import { checkPassphrase } from '../vault/passphrase';
import type { LedgerState } from '../vault/state';
import { sameJson } from '../vault/compare';
import { parseRequest, type AnyRequest, type ConsentResponse, type LegacyReadResponse, type ReadResponse, type Request, type Response, type VaultResponse } from './messages';

export interface HandlerDeps {
  local: StorageAreaLike;
  session: StorageAreaLike;
  /**
   * Restricts both storage areas to this extension's own pages and worker.
   * Awaited before every request; if it rejects, nothing is read, written,
   * unlocked or kept in session storage.
   */
  ensureAccess: () => Promise<void>;
  now?: () => string;
  /** Random ids for vaults, session generations and erase markers. */
  newId?: () => string;
  /** Tells open pages that the vault or consent state changed (agreement, lock, unlock, setup, migration, erase). Carries no data. */
  broadcast?: () => void;
}

export interface Handler {
  handle(raw: unknown): Promise<unknown>;
}

/** What the stored records are, before any key is used. */
type Inspected =
  | { kind: 'final'; state: LedgerState; legacy: StoreData | null }
  | { kind: 'setup'; erase: EraseMarker | null }
  | { kind: 'migration'; stage: 'legacy' | 'interrupted' | 'candidate_unreadable'; legacy: StoreData; vaultRaw: unknown }
  | { kind: 'pending'; marker: MigrationMarker; legacy: StoreData; vault: VaultEnvelope }
  | { kind: 'vault'; vault: VaultEnvelope; marker: MigrationMarker | null };

type Opened =
  | { kind: 'ok'; store: StoreData; key: CryptoKey }
  | { kind: 'locked' }
  | { kind: 'unreadable'; state: LedgerState };

class SessionReadError extends Error {}

const vaultErr = (code: Extract<VaultResponse, { ok: false }>['error']['code'], message: string): VaultResponse => ({ ok: false, error: { code, message } });
const vaultOk = (outcome: Extract<VaultResponse, { ok: true }>['outcome'], message: string): VaultResponse => ({ ok: true, outcome, message });
const consentErr = (code: Extract<ConsentResponse, { ok: false }>['error']['code'], message: string): ConsentResponse => ({ ok: false, error: { code, message } });
const mutationErr = (code: Extract<Response, { ok: false }>['error']['code'], message: string): Response => ({ ok: false, error: { code, message } });

function legacyCases(store: StoreData): number {
  return store.cases.length;
}

export function createHandler(deps: HandlerDeps): Handler {
  const { local, session, ensureAccess } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const broadcast = deps.broadcast ?? (() => undefined);
  let queue: Promise<unknown> = Promise.resolve();
  /** The unlocked key, cached in memory. Valid only while it matches the session record and generation. */
  let memory: { vaultId: string; generation: string; key: CryptoKey } | null = null;

  // ---- Inspection (no key used) ----

  async function inspect(): Promise<Inspected> {
    let raw: Record<string, unknown>;
    try {
      raw = await local.get([...LEDGER_KEYS]);
    } catch (err) {
      return { kind: 'final', state: { status: 'storage_error', error: describeError(err) }, legacy: null };
    }
    const L = raw[LEGACY_STORE_KEY];
    const V = raw[VAULT_KEY];
    const M = raw[MIGRATION_KEY];
    const parsedLegacy = L === undefined ? null : parseStore(L);
    const lp = parsedLegacy?.status === 'ok' ? parsedLegacy.store : null;
    const legacyUnreadable: LedgerState | null =
      parsedLegacy === null || parsedLegacy.status === 'ok'
        ? null
        : parsedLegacy.status === 'corrupt'
          ? { status: 'corrupt', error: parsedLegacy.error, raw: L }
          : { status: 'unsupported_version', version: parsedLegacy.version, raw: L };
    const inconsistent = (detail: string, legacyReadable = lp !== null): Inspected => ({ kind: 'final', state: { status: 'inconsistent', detail, legacyReadable }, legacy: legacyReadable ? lp : null });

    const marker = M === undefined ? null : parseMigrationMarker(M);
    if (M !== undefined && marker === null) return inconsistent('The migration progress record is damaged, so this build will not guess which stored copy is complete.');

    if (V === undefined) {
      if (marker === null) {
        if (L === undefined) return { kind: 'setup', erase: parseEraseMarker(raw[ERASE_KEY]) };
        if (lp) return { kind: 'migration', stage: 'legacy', legacy: lp, vaultRaw: undefined };
        if (legacyUnreadable) return { kind: 'final', state: legacyUnreadable, legacy: null };
      }
      if (lp) return { kind: 'migration', stage: 'interrupted', legacy: lp, vaultRaw: undefined };
      if (legacyUnreadable) return { kind: 'final', state: legacyUnreadable, legacy: null };
      return inconsistent('A migration was started, but neither the original records nor an encrypted copy are stored.');
    }

    const env = parseEnvelope(V);
    if (env.status !== 'ok') {
      if (marker && lp) return { kind: 'migration', stage: 'candidate_unreadable', legacy: lp, vaultRaw: V };
      if (lp) return inconsistent('Unreadable encrypted records and readable plaintext records from an earlier version are both stored.');
      return { kind: 'final', state: { status: 'vault_unreadable', reason: env.status === 'unsupported' ? 'unsupported' : 'corrupt', detail: env.detail }, legacy: null };
    }
    const vault = env.envelope;
    if (marker) {
      if (marker.vaultId !== vault.vaultId) return inconsistent('The migration progress record names a different encrypted vault than the one stored.');
      if (lp) return { kind: 'pending', marker, legacy: lp, vault };
      if (legacyUnreadable) return inconsistent('The plaintext original became unreadable while its encrypted copy was still unverified.', false);
      // The original was removed only after verification, so the vault is the complete copy.
      return { kind: 'vault', vault, marker };
    }
    if (L !== undefined) {
      return inconsistent('Encrypted records and plaintext records from an earlier version are both stored, without a migration in progress (for example after an older version was installed again).');
    }
    return { kind: 'vault', vault, marker: null };
  }

  // ---- Session ----

  async function sessionKey(vault: VaultEnvelope): Promise<CryptoKey | null> {
    let s: Record<string, unknown>;
    try {
      s = await session.get([SESSION_KEY, GENERATION_KEY]);
    } catch (err) {
      throw new SessionReadError(describeError(err));
    }
    const generation = s[GENERATION_KEY];
    const record = parseSessionRecord(s[SESSION_KEY]);
    if (!isId(generation) || !record || record.vaultId !== vault.vaultId || record.generation !== generation) {
      memory = null;
      return null;
    }
    if (memory && memory.vaultId === vault.vaultId && memory.generation === generation) return memory.key;
    const key = await importRawKey(record.key);
    memory = key ? { vaultId: vault.vaultId, generation, key } : null;
    return key;
  }

  async function ensureGeneration(): Promise<string> {
    const s = await session.get(GENERATION_KEY);
    const g = s[GENERATION_KEY];
    if (isId(g)) return g;
    const fresh = newId();
    await session.set({ [GENERATION_KEY]: fresh });
    return fresh;
  }

  async function installSession(vaultId: string, dataKey: CryptoKey, generation: string): Promise<void> {
    const raw = await exportRawKey(dataKey);
    await session.set({ [SESSION_KEY]: { format: SESSION_FORMAT, formatVersion: 1, vaultId, generation, key: raw } });
    const key = await importRawKey(raw);
    memory = key ? { vaultId, generation, key } : null;
  }

  /** Revokes every earlier session record (new generation) and removes the current one. Returns false if neither step succeeded. */
  async function revokeSession(): Promise<boolean> {
    memory = null;
    const results = await Promise.allSettled([session.set({ [GENERATION_KEY]: newId() }), session.remove(SESSION_KEY)]);
    return results.some((r) => r.status === 'fulfilled');
  }

  async function openVault(vault: VaultEnvelope): Promise<Opened> {
    let key: CryptoKey | null;
    try {
      key = await sessionKey(vault);
    } catch (err) {
      return { kind: 'unreadable', state: { status: 'storage_error', error: `session storage could not be read: ${describeError(err)}` } };
    }
    if (!key) return { kind: 'locked' };
    const opened = await openPayload(key, vault);
    switch (opened.status) {
      case 'ok':
        return { kind: 'ok', store: opened.store, key };
      case 'auth_failed':
        return { kind: 'unreadable', state: { status: 'vault_unreadable', reason: 'payload_invalid', detail: 'The encrypted records could not be authenticated with the unlocked key, so they may be damaged.' } };
      case 'invalid':
        return { kind: 'unreadable', state: { status: 'vault_unreadable', reason: 'payload_invalid', detail: opened.detail } };
      case 'unsupported':
        return { kind: 'unreadable', state: { status: 'vault_unreadable', reason: 'payload_unsupported', detail: opened.detail } };
    }
  }

  // ---- Reads ----

  async function read(): Promise<ReadResponse> {
    const ins = await inspect();
    switch (ins.kind) {
      case 'final':
        return { ok: true, ledger: ins.state };
      case 'setup':
        return { ok: true, ledger: { status: 'setup_required', erased: ins.erase !== null } };
      case 'migration':
        return { ok: true, ledger: { status: 'migration_required', stage: ins.stage, legacyCases: legacyCases(ins.legacy) } };
      case 'pending':
        return { ok: true, ledger: { status: 'migration_pending', stage: ins.marker.phase, legacyCases: legacyCases(ins.legacy) } };
      case 'vault': {
        const opened = await openVault(ins.vault);
        if (opened.kind === 'locked') return { ok: true, ledger: { status: 'locked' } };
        if (opened.kind === 'unreadable') return { ok: true, ledger: opened.state };
        return { ok: true, ledger: { status: 'ok', store: opened.store, isNew: false, vaultId: ins.vault.vaultId } };
      }
    }
  }

  async function readLegacy(): Promise<LegacyReadResponse> {
    const ins = await inspect();
    if (ins.kind === 'migration' || ins.kind === 'pending') return { ok: true, store: ins.legacy };
    if (ins.kind === 'final' && ins.legacy) return { ok: true, store: ins.legacy };
    return { ok: false, error: { code: 'wrong_state', message: 'There are no readable plaintext records from an earlier version to back up.' } };
  }

  // ---- Mutations (unchanged ledger rules; now encrypted) ----

  async function unlockedLedger(): Promise<{ ok: true; vault: VaultEnvelope; store: StoreData; key: CryptoKey } | { ok: false; res: Response }> {
    const ins = await inspect();
    switch (ins.kind) {
      case 'final': {
        const s = ins.state;
        if (s.status === 'storage_error') return { ok: false, res: mutationErr('storage_error', `Saved data could not be read, so no change was attempted: ${s.error}`) };
        if (s.status === 'unsupported_version' || (s.status === 'vault_unreadable' && (s.reason === 'unsupported' || s.reason === 'payload_unsupported'))) {
          return { ok: false, res: mutationErr('storage_unsupported', 'Stored data uses an unsupported version, so no change was attempted.') };
        }
        if (s.status === 'corrupt' || s.status === 'vault_unreadable') return { ok: false, res: mutationErr('storage_unreadable', 'Stored data could not be read, so no change was attempted.') };
        return { ok: false, res: mutationErr('vault_not_ready', 'Stored records need attention before they can be changed, so no change was attempted.') };
      }
      case 'setup':
      case 'migration':
      case 'pending':
        return { ok: false, res: mutationErr('vault_not_ready', 'Your records must be protected with a passphrase first, so no change was attempted.') };
      case 'vault': {
        const opened = await openVault(ins.vault);
        if (opened.kind === 'locked') return { ok: false, res: mutationErr('vault_locked', 'Your records are locked, so no change was attempted. Unlock them in the dashboard first.') };
        if (opened.kind === 'unreadable') {
          return opened.state.status === 'storage_error'
            ? { ok: false, res: mutationErr('storage_error', `Saved data could not be read, so no change was attempted: ${opened.state.error}`) }
            : { ok: false, res: mutationErr('storage_unreadable', 'Stored data could not be read, so no change was attempted.') };
        }
        return { ok: true, vault: ins.vault, store: opened.store, key: opened.key };
      }
    }
  }

  async function writeLedger(vault: VaultEnvelope, key: CryptoKey, store: StoreData): Promise<void> {
    // Fresh random IV on every call, including a retry of a rejected write.
    const next = await sealPayload(key, vault, store);
    await local.set({ [VAULT_KEY]: next });
  }

  async function mutate(req: Request): Promise<Response> {
    const loaded = await unlockedLedger();
    if (!loaded.ok) return loaded.res;
    const { vault, store, key } = loaded;

    if (req.kind === 'restore') {
      // Destination re-read, decrypted and validated above, inside the
      // serialised queue, immediately before deciding: emptiness, staleness
      // and receipt checks here cannot be bypassed by a page. A vault always
      // exists once set up, so its ledger is always "stored".
      const digest = await restorePayloadDigest(req.backup.exportedAt, req.backup.store);
      const decision = decideRestore(store, true, req, digest, now());
      switch (decision.kind) {
        case 'refused':
          return mutationErr(decision.code, decision.message);
        case 'already_restored':
          return { ok: true, outcome: 'duplicate', revision: decision.revision };
        case 'empty_backup':
          return { ok: true, outcome: 'unchanged', revision: decision.revision };
        case 'write':
          break;
      }
      // Defence in depth: never write a ledger that would not read back as valid.
      const check = parseStore(JSON.parse(JSON.stringify(decision.store)));
      if (check.status !== 'ok') return mutationErr('not_applied', 'The restored data did not pass validation, so nothing was written.');
      try {
        // One write: the restored cases and the receipt that identifies this operation.
        await writeLedger(vault, key, decision.store);
      } catch (err) {
        return mutationErr('write_rejected', `Storage rejected the restore, so nothing was restored: ${describeError(err)}`);
      }
      return { ok: true, outcome: 'applied', revision: decision.store.revision };
    }

    const result = applyCommand(store, req.command, now());
    if (!result.ok) return { ok: false, error: result.error };
    if (result.outcome !== 'applied') return { ok: true, outcome: result.outcome, revision: store.revision };
    try {
      await writeLedger(vault, key, result.store);
    } catch (err) {
      // chrome.storage.local.set rejected: the write was not committed.
      return mutationErr('write_rejected', `Storage rejected the change, so it was not saved: ${describeError(err)}`);
    }
    return { ok: true, outcome: 'applied', revision: result.store.revision };
  }

  // ---- Setup ----

  async function setup(passphrase: string): Promise<VaultResponse> {
    const pass = checkPassphrase(passphrase);
    if (!pass.ok) return vaultErr('passphrase_rejected', 'That passphrase does not meet the rules, so nothing was set up.');
    const ins = await inspect();
    if (ins.kind === 'final' && ins.state.status === 'storage_error') return vaultErr('storage_error', `Saved data could not be read, so nothing was set up: ${ins.state.error}`);
    if (ins.kind !== 'setup') return vaultErr('wrong_state', 'Stored records already exist, so a new vault was not created. Nothing was changed.');
    let generation: string;
    try {
      generation = await ensureGeneration();
    } catch (err) {
      return vaultErr('session_unavailable', `Chrome’s session storage could not be used, so nothing was set up and no key was kept: ${describeError(err)}`);
    }
    const vaultId = newId();
    // A fresh marker on every new vault, so approvals made before an erase or re-setup can never match it.
    const initial: StoreData = { schemaVersion: SCHEMA_VERSION, revision: 0, cases: [], ledgerEpoch: ins.erase?.epoch ?? newId() };
    const { envelope, dataKey } = await createVault(pass.bytes, vaultId, initial);
    try {
      await local.set({ [VAULT_KEY]: envelope });
    } catch (err) {
      return vaultErr('write_rejected', `Storage rejected the new encrypted ledger, so nothing was set up: ${describeError(err)}`);
    }
    // Committed: from here on the result is never "nothing was saved".
    try {
      await installSession(vaultId, dataKey, generation);
    } catch {
      broadcast();
      return vaultOk('protected_locked', 'Your records are protected, but this browser session could not be unlocked. Unlock with your passphrase to continue.');
    }
    broadcast();
    return vaultOk('unlocked', 'Your records are protected and unlocked for this browser session.');
  }

  // ---- Migration of plaintext records from an earlier version ----

  /** Steps after a verified candidate: mark verified, remove the plaintext original, remove the marker. */
  async function finishMigration(vaultId: string): Promise<VaultResponse | null> {
    try {
      await local.set({ [MIGRATION_KEY]: { format: MIGRATION_FORMAT, formatVersion: 1, phase: 'verified', vaultId } satisfies MigrationMarker });
    } catch (err) {
      return vaultErr('migration_incomplete', `The encrypted copy matches your records, but finishing failed, so the plaintext original was kept: ${describeError(err)} Unlock with your new passphrase to finish.`);
    }
    try {
      await local.remove(LEGACY_STORE_KEY);
    } catch (err) {
      return vaultErr('migration_incomplete', `The encrypted copy is verified, but the plaintext original could not be removed yet: ${describeError(err)} Unlock with your new passphrase to try again.`);
    }
    // Harmless if this fails: the marker without an original is cleaned up on the next unlock.
    await local.remove(MIGRATION_KEY).catch(() => undefined);
    return null;
  }

  /** Re-reads the stored copies and checks them field for field against what was written and what was migrated. */
  async function verifyCandidate(envelope: VaultEnvelope, marker: MigrationMarker, legacy: StoreData, dataKey: CryptoKey): Promise<'ok' | 'unreadable' | 'mismatch'> {
    let raw: Record<string, unknown>;
    try {
      raw = await local.get([LEGACY_STORE_KEY, VAULT_KEY, MIGRATION_KEY]);
    } catch {
      return 'unreadable';
    }
    const fresh = parseStore(raw[LEGACY_STORE_KEY]);
    if (fresh.status !== 'ok' || !sameJson(fresh.store, legacy)) return 'mismatch';
    if (!sameJson(raw[VAULT_KEY], envelope) || !sameJson(raw[MIGRATION_KEY], marker)) return 'mismatch';
    const env = parseEnvelope(raw[VAULT_KEY]);
    if (env.status !== 'ok') return 'mismatch';
    const opened = await openPayload(dataKey, env.envelope);
    return opened.status === 'ok' && sameJson(opened.store, legacy) ? 'ok' : 'mismatch';
  }

  function approximateBytes(v: unknown): number {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  }

  async function migrate(passphrase: string, replaceCandidate: boolean): Promise<VaultResponse> {
    const pass = checkPassphrase(passphrase);
    if (!pass.ok) return vaultErr('passphrase_rejected', 'That passphrase does not meet the rules, so nothing was changed.');
    const ins = await inspect();
    if (ins.kind === 'final' && ins.state.status === 'storage_error') return vaultErr('storage_error', `Saved data could not be read, so nothing was changed: ${ins.state.error}`);
    const replacing = ins.kind === 'pending' || (ins.kind === 'migration' && ins.vaultRaw !== undefined);
    if (ins.kind !== 'migration' && ins.kind !== 'pending') return vaultErr('wrong_state', 'There are no plaintext records waiting to be encrypted. Nothing was changed.');
    if (ins.kind === 'pending' && !replaceCandidate) {
      return vaultErr('wrong_state', 'An encrypted copy already exists. Unlock with its passphrase to finish, or choose to start again with a new passphrase. Nothing was changed.');
    }
    const legacy = ins.legacy;
    let generation: string;
    try {
      generation = await ensureGeneration();
    } catch (err) {
      return vaultErr('session_unavailable', `Chrome’s session storage could not be used, so nothing was changed and no key was kept: ${describeError(err)}`);
    }

    const vaultId = newId();
    const { envelope, dataKey } = await createVault(pass.bytes, vaultId, legacy);
    const marker: MigrationMarker = { format: MIGRATION_FORMAT, formatVersion: 1, phase: 'candidate', vaultId };

    // Both copies must fit at once under the existing quota (no unlimitedStorage).
    if (local.getBytesInUse && local.quotaBytes) {
      try {
        const used = await local.getBytesInUse(null);
        const replaced = ins.kind === 'pending' ? approximateBytes(ins.vault) : ins.vaultRaw === undefined ? 0 : approximateBytes(ins.vaultRaw);
        if (used - replaced + approximateBytes(envelope) + approximateBytes(marker) + 256 > local.quotaBytes) {
          return vaultErr(
            'insufficient_space',
            'There is not enough room in this browser’s extension storage to keep an encrypted copy beside your current records while it is checked, so nothing was changed. Your plaintext records are intact. Download a plaintext backup, then delete cases you no longer need (for example the synthetic demo) and try again.',
          );
        }
      } catch {
        // The real write below still reports a full quota as a rejected write.
      }
    }

    if (replacing) {
      // Remove the unverified copy first, so a stored marker never names a vault other than the one stored.
      try {
        await local.remove(VAULT_KEY);
      } catch (err) {
        return vaultErr('write_rejected', `The earlier unverified encrypted copy could not be replaced: ${describeError(err)} Nothing else was changed; your plaintext records are intact.`);
      }
    }
    try {
      await local.set({ [MIGRATION_KEY]: marker });
    } catch (err) {
      if (replacing) broadcast();
      return vaultErr('write_rejected', `Storage rejected the migration record, so no encrypted copy was written. Your plaintext records are intact: ${describeError(err)}`);
    }
    try {
      await local.set({ [VAULT_KEY]: envelope });
    } catch (err) {
      broadcast();
      return vaultErr('write_rejected', `Storage rejected the encrypted copy (it may be too large for the remaining space), so your plaintext records were kept unchanged and nothing was migrated: ${describeError(err)}`);
    }
    // The candidate is committed: every later failure leaves it beside the intact original.
    broadcast();
    const verified = await verifyCandidate(envelope, marker, legacy, dataKey);
    if (verified === 'unreadable') {
      return vaultErr('migration_unverified', 'An encrypted copy was written, but it could not be read back to check it, so your plaintext records were kept. Unlock with your new passphrase to check it and finish.');
    }
    if (verified === 'mismatch') {
      return vaultErr('migration_blocked', 'The encrypted copy did not match your records exactly, so your plaintext records were kept and nothing was removed. Download a plaintext backup, then start again.');
    }
    const finished = await finishMigration(vaultId);
    if (finished) return finished;
    try {
      await installSession(vaultId, dataKey, generation);
    } catch {
      broadcast();
      return vaultOk('protected_locked', 'Your records are now encrypted, but this browser session could not be unlocked. Unlock with your new passphrase to continue.');
    }
    broadcast();
    return vaultOk('unlocked', 'Your existing records are now encrypted and unlocked for this browser session.');
  }

  // ---- Unlock, Lock, erase ----

  async function unlock(passphrase: string): Promise<VaultResponse> {
    const pass = checkPassphrase(passphrase);
    // A phrase that breaks the setup rules can never be right; same honest message as a wrong one.
    if (!pass.ok) return vaultErr('unlock_failed', 'That passphrase did not unlock your records. Check it and try again.');
    const ins = await inspect();
    if (ins.kind === 'final') {
      if (ins.state.status === 'storage_error') return vaultErr('storage_error', `Saved data could not be read, so nothing was unlocked: ${ins.state.error}`);
      if (ins.state.status === 'vault_unreadable') return vaultErr('vault_unreadable', 'The encrypted records cannot be read, so nothing was unlocked. Nothing was changed or reset.');
      return vaultErr('wrong_state', 'Stored records need attention before they can be unlocked. Nothing was changed.');
    }
    if (ins.kind !== 'vault' && ins.kind !== 'pending') return vaultErr('wrong_state', 'There is no encrypted vault to unlock. Nothing was changed.');
    let generation: string;
    try {
      generation = await ensureGeneration();
    } catch (err) {
      return vaultErr('session_unavailable', `Chrome’s session storage could not be used, so nothing was unlocked and no key was kept: ${describeError(err)}`);
    }
    const vault = ins.vault;
    // Checked canonical and exactly 16 bytes by parseEnvelope().
    const salt = base64ToBytes(vault.kdf.salt) ?? new Uint8Array(0);
    const wrappingKey = await deriveWrappingKey(pass.bytes, salt);
    const dataKey = await unwrapDataKey(wrappingKey, vault);
    if (!dataKey) {
      return vaultErr('unlock_failed', 'That passphrase did not unlock your records. Either it is not the passphrase you set, or the stored key is damaged; these cannot be told apart. Check it and try again.');
    }
    const opened = await openPayload(dataKey, vault);
    if (opened.status !== 'ok') {
      return vaultErr('vault_unreadable', 'The passphrase opened the stored key, but the encrypted records are damaged or unreadable. Nothing was changed or reset, and no new ledger was created.');
    }
    let finishedMigration = false;
    if (ins.kind === 'pending') {
      const verified = await verifyCandidate(vault, ins.marker, ins.legacy, dataKey);
      if (verified === 'unreadable') return vaultErr('storage_error', 'Saved data could not be re-read to check the encrypted copy, so nothing was changed. Try again.');
      if (verified === 'mismatch') {
        return vaultErr('migration_blocked', 'The encrypted copy and your plaintext records differ, so neither was changed or preferred. Download the plaintext backup, then start migration again or erase stored data.');
      }
      const finished = await finishMigration(vault.vaultId);
      if (finished) {
        broadcast();
        return finished;
      }
      finishedMigration = true;
    } else if (ins.marker) {
      // Leftover progress record after a completed migration.
      await local.remove(MIGRATION_KEY).catch(() => undefined);
    }
    try {
      await installSession(vault.vaultId, dataKey, generation);
    } catch (err) {
      if (finishedMigration) broadcast();
      return vaultErr(
        'session_unavailable',
        `${finishedMigration ? 'Your records are now encrypted, but this' : 'The passphrase is correct, but this'} browser session could not be kept unlocked (${describeError(err)}). Try again.`,
      );
    }
    broadcast();
    return vaultOk('unlocked', finishedMigration ? 'Your existing records are now encrypted and unlocked for this browser session.' : 'Unlocked for this browser session.');
  }

  async function lock(): Promise<VaultResponse> {
    const revoked = await revokeSession();
    broadcast();
    return revoked
      ? vaultOk('locked', 'Locked. Your passphrase is needed to see or change your records again.')
      : vaultErr('lock_incomplete', 'This worker forgot the key, but Chrome refused to clear the session record. Close and reopen Chrome to be sure the records are locked.');
  }

  async function eraseAll(): Promise<VaultResponse> {
    await revokeSession();
    try {
      // The consent receipt goes in the same removal: a new start shows the data practices again.
      await local.remove([LEGACY_STORE_KEY, VAULT_KEY, MIGRATION_KEY, CONSENT_KEY]);
    } catch (err) {
      broadcast();
      return vaultErr('write_rejected', `Chrome refused to remove the stored records, so they may be unchanged: ${describeError(err)}`);
    }
    try {
      await local.set({ [ERASE_KEY]: { format: ERASE_FORMAT, formatVersion: 1, epoch: newId() } satisfies EraseMarker });
    } catch (err) {
      broadcast();
      return vaultErr('erase_incomplete', `Stored records were removed, but the new erase marker could not be written: ${describeError(err)} Earlier restore approvals still cannot apply, because a new vault always gets a new identity.`);
    }
    broadcast();
    return vaultOk('erased', 'Stored data erased, including your agreement to the data practices. To start again, review them and set up a new passphrase.');
  }

  // ---- Consent ----

  type Gate = { ok: true } | { ok: false; reason: 'missing' | 'obsolete' | 'invalid' } | { ok: false; reason: 'storage_error'; error: string };

  /** Reads only the consent receipt. Never touches the ledger keys. */
  async function consentGate(): Promise<Gate> {
    let raw: Record<string, unknown>;
    try {
      raw = await local.get(CONSENT_KEY);
    } catch (err) {
      return { ok: false, reason: 'storage_error', error: describeError(err) };
    }
    const c = parseConsent(raw[CONSENT_KEY]);
    return c.status === 'accepted' ? { ok: true } : { ok: false, reason: c.status };
  }

  async function acceptDataPractices(version: number): Promise<ConsentResponse> {
    if (version !== DATA_PRACTICES_VERSION) {
      return consentErr('version_mismatch', `This version of Refund Reconciler shows data practices version ${DATA_PRACTICES_VERSION}, not ${version}. Nothing was stored; reload the dashboard and review them again.`);
    }
    const gate = await consentGate();
    if (gate.ok) return { ok: true, outcome: 'already_accepted', message: 'You have already agreed to these data practices. Nothing was changed.' };
    if (gate.reason === 'storage_error') return consentErr('storage_error', `Your current agreement could not be read, so nothing was stored: ${gate.error}`);
    try {
      // Replaces only an obsolete or damaged receipt; the records are not touched.
      await local.set({ [CONSENT_KEY]: makeReceipt(now()) });
    } catch (err) {
      return consentErr('write_rejected', `Chrome refused to store your agreement, so it was not recorded: ${describeError(err)}`);
    }
    broadcast();
    return { ok: true, outcome: 'accepted', message: 'Thank you. Your agreement is stored in this browser profile.' };
  }

  /** The refusal a gated request gets without a current agreement. Nothing was read beyond the receipt. */
  function gateRefusal(req: AnyRequest, gate: Exclude<Gate, { ok: true }>): unknown {
    if (gate.reason === 'storage_error') {
      const message = `Your agreement to the data practices could not be read, so nothing else was read or changed: ${gate.error}`;
      if (req.kind === 'read') return { ok: true, ledger: { status: 'storage_error', error: message } } satisfies ReadResponse;
      if (req.kind === 'readLegacy') return { ok: false, error: { code: 'storage_error', message } } satisfies LegacyReadResponse;
      if (req.kind === 'mutate' || req.kind === 'restore') return mutationErr('storage_error', message);
      return vaultErr('storage_error', message);
    }
    const message = 'Review the data practices in the dashboard and choose Agree and continue first. Nothing was read or changed.';
    if (req.kind === 'read') return { ok: true, ledger: { status: 'consent_required', reason: gate.reason, version: DATA_PRACTICES_VERSION } } satisfies ReadResponse;
    if (req.kind === 'readLegacy') return { ok: false, error: { code: 'consent_required', message } } satisfies LegacyReadResponse;
    if (req.kind === 'mutate' || req.kind === 'restore') return mutationErr('consent_required', message);
    return vaultErr('consent_required', message);
  }

  // ---- Dispatch ----

  async function processRequest(req: AnyRequest): Promise<unknown> {
    switch (req.kind) {
      case 'read':
        return read();
      case 'readLegacy':
        return readLegacy();
      case 'mutate':
      case 'restore':
        return mutate(req);
      case 'setup':
        return setup(req.passphrase);
      case 'migrate':
        return migrate(req.passphrase, req.replaceCandidate);
      case 'unlock':
        return unlock(req.passphrase);
      case 'lock':
        return lock();
      case 'eraseAll':
        return eraseAll();
      case 'acceptDataPractices':
        return acceptDataPractices(req.version);
    }
  }

  function unavailable(req: AnyRequest, error: string): unknown {
    const message = `Extension storage could not be restricted to this extension’s own pages, so nothing was read, written or unlocked: ${error}`;
    if (req.kind === 'read') return { ok: true, ledger: { status: 'storage_unavailable', error } } satisfies ReadResponse;
    if (req.kind === 'mutate' || req.kind === 'restore') return mutationErr('storage_error', message);
    if (req.kind === 'acceptDataPractices') return consentErr('storage_unavailable', message);
    return vaultErr('storage_unavailable', message);
  }

  async function process(raw: unknown): Promise<unknown> {
    const parsed = parseRequest(raw);
    if (!parsed.ok) return { ok: false, error: { code: 'invalid_message', message: parsed.error } };
    const req = parsed.value;
    if (req.kind === 'lock' || req.kind === 'eraseAll') memory = null;
    try {
      await ensureAccess();
    } catch (err) {
      if (req.kind === 'lock' || req.kind === 'eraseAll') await revokeSession();
      return unavailable(req, describeError(err));
    }
    try {
      // Lock, erase and the agreement itself never need a prior agreement.
      if (req.kind !== 'lock' && req.kind !== 'eraseAll' && req.kind !== 'acceptDataPractices') {
        const gate = await consentGate();
        if (!gate.ok) return gateRefusal(req, gate);
      }
      return await processRequest(req);
    } catch (err) {
      // Mutations throw only before their write (e.g. an unsafe monetary sum), so nothing was written.
      if (req.kind === 'mutate' || req.kind === 'restore') return mutationErr('not_applied', `The change could not be applied, so nothing was written: ${describeError(err)}`);
      if (req.kind === 'read') return { ok: true, ledger: { status: 'storage_error', error: describeError(err) } } satisfies ReadResponse;
      if (req.kind === 'readLegacy') return { ok: false, error: { code: 'storage_error', message: describeError(err) } } satisfies LegacyReadResponse;
      broadcast();
      if (req.kind === 'acceptDataPractices') return consentErr('outcome_unknown', `An unexpected error stopped the agreement (${describeError(err)}). The current state is shown; check it before trying again.`);
      return vaultErr('outcome_unknown', `An unexpected error stopped this action, and it may have been partly completed (${describeError(err)}). The current state is shown; check it before trying again.`);
    }
  }

  return {
    handle(raw) {
      const run = queue.then(() => process(raw));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
