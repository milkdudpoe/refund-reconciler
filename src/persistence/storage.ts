// Storage keys and the minimal storage interface used by the service worker.
// Only the service worker reads or writes these keys in production. Reads are
// validated before use; nothing here ever repairs, migrates or resets data.

/** Plaintext ledger written by versions before 0.7.0 (schema 1). Read only for migration. */
export const LEGACY_STORE_KEY = 'refundReconciler.store';
/** The encrypted vault envelope (src/vault/format.ts). */
export const VAULT_KEY = 'refundReconciler.vault';
/** Nonprivate migration progress marker (src/vault/format.ts MigrationMarker). */
export const MIGRATION_KEY = 'refundReconciler.migration';
/** Nonprivate marker left by an explicit erase (src/vault/format.ts EraseMarker). */
export const ERASE_KEY = 'refundReconciler.erased';

/** chrome.storage.session only: the unlocked data key, bound to a vault and a generation. */
export const SESSION_KEY = 'refundReconciler.session';
/** chrome.storage.session only: changed by every Lock and erase, invalidating earlier session records. */
export const GENERATION_KEY = 'refundReconciler.sessionGeneration';

/** Every chrome.storage.local key this extension uses. */
export const LOCAL_KEYS = [LEGACY_STORE_KEY, VAULT_KEY, MIGRATION_KEY, ERASE_KEY] as const;

/** The subset of chrome.storage.StorageArea we use, so tests can inject fakes. */
export interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Bytes currently used (chrome.storage.local only; used to check room before a migration). */
  getBytesInUse?(keys: null): Promise<number>;
  /** The area's quota in bytes, if known. */
  readonly quotaBytes?: number;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// The bindings call chrome.storage.* at call time (not captured at start-up).
export function chromeLocalArea(): StorageAreaLike {
  return {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    remove: (keys) => chrome.storage.local.remove(keys),
    getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
    get quotaBytes() {
      return chrome.storage.local.QUOTA_BYTES;
    },
  };
}

export function chromeSessionArea(): StorageAreaLike {
  return {
    get: (keys) => chrome.storage.session.get(keys),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}
