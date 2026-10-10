// Browser-test helpers for the encrypted vault. Test code only; nothing here
// is in the extension.
//
// Disclosed test setup: to inspect or seed the stored ledger, these helpers
// run, inside an extension page or the service worker, an INDEPENDENT
// implementation of the documented vault-format-1 payload encryption
// (AES-256-GCM, 12-byte IV, AAD = UTF-8 JSON
// ["refund-reconciler-vault",1,"ledger-payload",vaultId,"AES-256-GCM"]),
// using the data key from the session record that the extension itself wrote
// when it was unlocked through the real UI. They never derive keys, never
// unlock anything and never change the production code path: seeding writes a
// ciphertext exactly as the service worker would, and the extension decrypts
// and validates it itself. Reading decrypts the stored bytes as stored, so a
// deliberately corrupt seeded value reads back unchanged.

import { expect, type Page, type Worker } from '@playwright/test';

export const TEST_PHRASE = 'synthetic e2e passphrase 0001';
export const VAULT_KEY = 'refundReconciler.vault';
export const LEGACY_KEY = 'refundReconciler.store';

type Target = Page | Worker;

/** The stored ledger: the vault's decrypted plaintext JSON if a vault exists, else the plaintext key's value (or undefined). */
export async function decryptedRaw(target: Target): Promise<unknown> {
  return (target as Page).evaluate(async () => {
    const local = await chrome.storage.local.get(['refundReconciler.vault', 'refundReconciler.store']);
    const env = local['refundReconciler.vault'] as { vaultId: string; payload: { iv: string; ciphertext: string } } | undefined;
    if (!env) return local['refundReconciler.store'];
    const { 'refundReconciler.session': rec } = (await chrome.storage.session.get('refundReconciler.session')) as { 'refundReconciler.session'?: { key: string; vaultId: string } };
    if (!rec || rec.vaultId !== env.vaultId) throw new Error('test helper: the vault is not unlocked in this session');
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', bytes(rec.key), 'AES-GCM', false, ['decrypt']);
    const aad = new TextEncoder().encode(JSON.stringify(['refund-reconciler-vault', 1, 'ledger-payload', env.vaultId, 'AES-256-GCM']));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(env.payload.iv), additionalData: aad, tagLength: 128 }, key, bytes(env.payload.ciphertext));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as unknown;
  });
}

/** Replaces the vault's payload with `value` encrypted under the unlocked data key (fresh IV), as the service worker would write it. */
export async function writeVaultPayload(target: Target, value: unknown): Promise<void> {
  await (target as Page).evaluate(async (v) => {
    const { 'refundReconciler.vault': env } = (await chrome.storage.local.get('refundReconciler.vault')) as { 'refundReconciler.vault'?: Record<string, unknown> & { vaultId: string } };
    const { 'refundReconciler.session': rec } = (await chrome.storage.session.get('refundReconciler.session')) as { 'refundReconciler.session'?: { key: string; vaultId: string } };
    if (!env || !rec || rec.vaultId !== env.vaultId) throw new Error('test helper: set up and unlock the vault first');
    const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
    const key = await crypto.subtle.importKey('raw', bytes(rec.key), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(JSON.stringify(['refund-reconciler-vault', 1, 'ledger-payload', env.vaultId, 'AES-256-GCM']));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(v))));
    let ctB64 = '';
    for (let i = 0; i < ct.length; i += 0x8000) ctB64 += String.fromCharCode(...ct.subarray(i, i + 0x8000));
    await chrome.storage.local.set({ 'refundReconciler.vault': { ...env, payload: { cipher: 'AES-256-GCM', iv: b64(iv), ciphertext: btoa(ctB64) } } });
  }, value);
}

/** The ledger state as the extension reports it through its own read protocol. */
export async function ledgerStatus(page: Page): Promise<string> {
  return page.evaluate(async () => ((await chrome.runtime.sendMessage({ kind: 'read' })) as { ledger: { status: string } }).ledger.status);
}

export const vaultScreen = (page: Page, id: 'vault-setup' | 'vault-locked' | 'vault-migrate' | 'vault-pending' | 'vault-unreadable' | 'vault-inconsistent') => page.getByTestId(id);

/** Any settled dashboard screen. */
export function anyScreen(page: Page) {
  return page
    .getByRole('heading', { name: 'Your cases' })
    .or(page.getByTestId('unreadable'))
    .or(page.getByTestId('storage-error'))
    .or(page.getByTestId('vault-setup'))
    .or(page.getByTestId('vault-locked'))
    .or(page.getByTestId('vault-migrate'))
    .or(page.getByTestId('vault-pending'))
    .or(page.getByTestId('vault-unreadable'))
    .or(page.getByTestId('vault-inconsistent'));
}

/** Fills the real "Protect your records" form and submits it. */
export async function fillNewPassphrase(page: Page, phrase = TEST_PHRASE): Promise<void> {
  await page.getByLabel('Passphrase', { exact: true }).fill(phrase);
  await page.getByLabel('Type the passphrase again').fill(phrase);
  await page.getByRole('checkbox', { name: /cannot be recovered except from a plaintext backup/ }).check();
}

export async function setupViaUi(page: Page, phrase = TEST_PHRASE): Promise<void> {
  await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
  await fillNewPassphrase(page, phrase);
  await page.getByRole('button', { name: 'Protect my records' }).click();
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible({ timeout: 15_000 });
}

export async function migrateViaUi(page: Page, phrase = TEST_PHRASE): Promise<void> {
  await expect(vaultScreen(page, 'vault-migrate')).toBeVisible();
  await fillNewPassphrase(page, phrase);
  await page.getByRole('button', { name: 'Encrypt my existing records' }).click();
  await expect(page.getByRole('heading', { name: 'Your cases' })).toBeVisible({ timeout: 15_000 });
}

export async function unlockViaUi(page: Page, phrase = TEST_PHRASE): Promise<void> {
  await expect(vaultScreen(page, 'vault-locked')).toBeVisible();
  await page.getByLabel('Passphrase', { exact: true }).fill(phrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your cases' }).or(page.getByTestId('vault-unreadable'))).toBeVisible({ timeout: 15_000 });
}

/** Explicit typed erase through the real UI (any screen that offers it). */
export async function eraseTyped(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Erase stored data…' });
  const forgot = page.getByText('Forgot your passphrase?');
  await expect(open.or(forgot).first()).toBeVisible();
  // On the unlock screen the erase control sits inside the "Forgot your passphrase?" section.
  if (!(await open.isVisible())) await forgot.click();
  await open.click();
  await expect(page.getByRole('button', { name: 'Permanently erase' })).toBeDisabled();
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Permanently erase' }).click();
  await expect(vaultScreen(page, 'vault-setup')).toBeVisible();
}
