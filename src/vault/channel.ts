/**
 * BroadcastChannel name the service worker uses to tell this extension's open
 * pages that the vault state changed (setup, migration, unlock, Lock, erase).
 * A BroadcastChannel is same-origin, so only this extension's own pages and
 * worker can post or receive on it. Messages carry no data: a page only
 * re-reads the state through the service worker.
 */
export const VAULT_CHANNEL = 'refund-reconciler-vault';
