// Shared helpers for export browser tests. Fault injection and gates live
// here, in test code only; the shipped extension has no test switches.

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect } from './fixtures';
import { decryptedRaw, writeVaultPayload } from './vault-helpers';

export const SUMMARY_FILE = /^refund-reconciler-case-summary-\d{4}-\d{2}-\d{2}T\d{6}Z\.txt$/;
export const BACKUP_FILE = /^refund-reconciler-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/;

/** The stored ledger as stored (decrypted by the test-side decoder; see vault-helpers.ts). */
export async function storedRaw(page: Page): Promise<unknown> {
  return decryptedRaw(page);
}

/**
 * Replaces the stored ledger with `value`, encrypted into the unlocked vault
 * exactly as the service worker writes it (disclosed test setup; see
 * vault-helpers.ts). The extension then decrypts and validates it itself, so
 * an invalid value is seen as unreadable stored data.
 */
export async function seed(page: Page, value: unknown): Promise<void> {
  await writeVaultPayload(page, value);
}

/** Clicks a button and returns the file the browser actually downloaded. */
export async function downloadVia(page: Page, buttonName: string): Promise<{ name: string; text: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: buttonName, exact: true }).click()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), text: await readFile(path, 'utf8') };
}

/** Counts download events on a page (to prove none happened). */
export function countDownloads(page: Page): { count: number } {
  const counter = { count: 0 };
  page.on('download', () => {
    counter.count += 1;
  });
  return counter;
}

/** Reads the real clipboard by pasting into a scratch textarea added by the test. */
export async function pasteClipboard(page: Page): Promise<string> {
  await page.evaluate(() => {
    document.getElementById('paste-probe')?.remove();
    const t = document.createElement('textarea');
    t.id = 'paste-probe';
    document.body.append(t);
  });
  await page.locator('#paste-probe').focus();
  await page.keyboard.press('Control+V');
  const value = await page.locator('#paste-probe').inputValue();
  await page.evaluate(() => document.getElementById('paste-probe')?.remove());
  return value;
}

type ReadWindow = Window & {
  __readMode?: 'reject' | 'corrupt' | 'real';
  __readHold?: { armed: boolean; held: boolean; release: () => void };
  __readWrapped?: boolean;
};

/**
 * Wraps, once, this page's chrome.runtime.sendMessage for READ requests only
 * (the page's only way to read saved data). Other requests pass through
 * untouched. The service worker and other pages are unaffected.
 */
async function wrapPageReads(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as ReadWindow;
    if (w.__readWrapped) return;
    w.__readWrapped = true;
    w.__readMode = 'real';
    const rt = chrome.runtime as unknown as { sendMessage: (msg: unknown) => Promise<unknown> };
    const inner = rt.sendMessage.bind(chrome.runtime);
    rt.sendMessage = async (msg: unknown) => {
      if ((msg as { kind?: unknown } | null)?.kind !== 'read') return inner(msg);
      if (w.__readMode === 'reject') throw new Error('Simulated read failure');
      // corrupt: a reply whose ledger fails the page's own validation.
      const reply = w.__readMode === 'corrupt'
        ? { ok: true, ledger: { status: 'ok', isNew: false, vaultId: 'simulated', store: { schemaVersion: 1, revision: 3, cases: [{ id: 'broken' }] } } }
        : await inner(msg);
      const hold = w.__readHold;
      if (hold?.armed) {
        hold.armed = false;
        await new Promise<void>((resolve) => {
          hold.release = resolve;
          hold.held = true;
        });
      }
      return reply;
    };
  });
}

/** Makes this page's own reads fail, return a reply that fails validation, or work normally (the service worker is unaffected). */
export async function overridePageReads(page: Page, mode: 'reject' | 'corrupt' | 'real'): Promise<void> {
  await wrapPageReads(page);
  await page.evaluate((m) => {
    (window as ReadWindow).__readMode = m;
  }, mode);
}

export async function openSummary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Prepare case summary…' }).click();
  await expect(page.getByRole('heading', { name: 'Case summary preview' })).toBeFocused();
  await expect(page.getByTestId('export-text')).toHaveValue(/REFUND RECORD SUMMARY/);
}


type GateWindow = Window & {
  __realWrite?: (text: string) => Promise<void>;
  __clip?: { calls: number; written: string[]; pending: { resolve: () => void; reject: (e: unknown) => void } | null };
};

/**
 * Holds the page's NEXT read reply after the service worker has answered it,
 * until releaseHeldRead(). Later reads (e.g. the dashboard's change-triggered
 * refresh) pass straight through.
 */
export async function holdNextRead(page: Page): Promise<void> {
  await wrapPageReads(page);
  await page.evaluate(() => {
    (window as ReadWindow).__readHold = { armed: true, held: false, release: () => undefined };
  });
}

export async function waitForHeldRead(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as ReadWindow).__readHold?.held === true)).toBe(true);
}

export async function releaseHeldRead(page: Page): Promise<void> {
  await page.evaluate(() => (window as ReadWindow).__readHold?.release());
}

/**
 * Wraps navigator.clipboard.writeText so each call performs the REAL write
 * (unless realWrite is false) and then waits for settleClipboard() before its
 * promise settles.
 */
export async function gateClipboard(page: Page, opts: { realWrite: boolean } = { realWrite: true }): Promise<void> {
  await page.evaluate((realWrite) => {
    const w = window as GateWindow;
    w.__realWrite ??= navigator.clipboard.writeText.bind(navigator.clipboard);
    const real = w.__realWrite;
    const clip: NonNullable<GateWindow['__clip']> = { calls: 0, written: [], pending: null };
    w.__clip = clip;
    navigator.clipboard.writeText = async (text: string) => {
      clip.calls += 1;
      if (realWrite) {
        await real(text);
        clip.written.push(text);
      }
      await new Promise<void>((resolve, reject) => {
        clip.pending = { resolve, reject };
      });
    };
  }, opts.realWrite);
}

export async function clipboardCalls(page: Page): Promise<{ calls: number; written: string[]; pending: boolean }> {
  return page.evaluate(() => {
    const c = (window as GateWindow).__clip!;
    return { calls: c.calls, written: c.written, pending: c.pending !== null };
  });
}

export async function waitForPendingCopy(page: Page): Promise<void> {
  await expect.poll(async () => (await clipboardCalls(page)).pending).toBe(true);
}

export async function settleClipboard(page: Page, outcome: 'resolve' | 'reject'): Promise<void> {
  await page.evaluate((o) => {
    const c = (window as GateWindow).__clip!;
    const p = c.pending;
    c.pending = null;
    if (o === 'resolve') p?.resolve();
    else p?.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
  }, outcome);
}

export async function restoreClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as GateWindow;
    if (w.__realWrite) navigator.clipboard.writeText = w.__realWrite;
  });
}
