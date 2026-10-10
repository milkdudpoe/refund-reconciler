// Persistence boundary. Reads are validated with parseStore(); nothing here
// ever repairs, migrates or resets data it cannot read.

import { parseStore } from '../domain/validate';
import { emptyStore, erasedStore, type StoreData } from '../domain/types';

/** All app data lives under this single chrome.storage.local key. */
export const STORE_KEY = 'refundReconciler.store';

/** The subset of chrome.storage.StorageArea we use, so tests can inject fakes. */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export type LoadResult =
  | { status: 'ok'; store: StoreData; isNew: boolean }
  | { status: 'unsupported_version'; version: unknown; raw: unknown }
  | { status: 'corrupt'; error: string; raw: unknown }
  | { status: 'storage_error'; error: string };

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function loadStore(area: StorageAreaLike): Promise<LoadResult> {
  let raw: unknown;
  try {
    const result = await area.get(STORE_KEY);
    raw = result[STORE_KEY];
  } catch (err) {
    return { status: 'storage_error', error: describeError(err) };
  }
  if (raw === undefined) return { status: 'ok', store: emptyStore(), isNew: true };
  const parsed = parseStore(raw);
  switch (parsed.status) {
    case 'ok':
      return { status: 'ok', store: parsed.store, isNew: false };
    case 'unsupported_version':
      return { status: 'unsupported_version', version: parsed.version, raw };
    case 'corrupt':
      return { status: 'corrupt', error: parsed.error, raw };
  }
}

/**
 * Writes the store. Under the chrome.storage API contract, a resolved set()
 * means the write was committed and a rejected one means it was not, so no
 * extra read-back is done (a failed read-back would otherwise make a committed
 * write look unsaved).
 */
export async function saveStore(area: StorageAreaLike, store: StoreData): Promise<void> {
  await area.set({ [STORE_KEY]: store });
}

/**
 * Explicit erase. Replaces whatever is stored (even corrupt or unsupported
 * data, which is never read or trusted here) with an empty ledger that holds
 * only a new random `ledgerEpoch`. One set(): if it is rejected, the original
 * data stays as it was. Keeping a marker instead of removing the key means an
 * approval made before the erase can never match the erased ledger.
 */
export async function eraseStore(area: StorageAreaLike, newEpoch: string): Promise<void> {
  await area.set({ [STORE_KEY]: erasedStore(newEpoch) });
}

export function chromeLocalArea(): StorageAreaLike {
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
    remove: (key) => chrome.storage.local.remove(key),
  };
}
