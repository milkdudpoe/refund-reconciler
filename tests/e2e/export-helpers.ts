// Shared helpers for export browser tests. Fault injection and gates live
// here, in test code only; the shipped extension has no test switches.

import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { STORE_KEY, expect } from './fixtures';

export const SUMMARY_FILE = /^refund-reconciler-case-summary-\d{4}-\d{2}-\d{2}T\d{6}Z\.txt$/;
export const BACKUP_FILE = /^refund-reconciler-backup-\d{4}-\d{2}-\d{2}T\d{6}Z\.json$/;

export async function storedRaw(page: Page): Promise<unknown> {
  return (await page.evaluate((key) => chrome.storage.local.get(key), STORE_KEY))[STORE_KEY];
}

export async function seed(page: Page, value: unknown): Promise<void> {
  await page.evaluate(([key, v]) => chrome.storage.local.set({ [key as string]: v }), [STORE_KEY, value] as const);
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

/** Makes this page's own chrome.storage.local.get fail or return a fixed value (the service worker is unaffected). */
export async function overridePageReads(page: Page, mode: 'reject' | 'corrupt' | 'real'): Promise<void> {
  await page.evaluate(
    ([m, key]) => {
      const area = chrome.storage.local as unknown as { get: unknown };
      const w = window as unknown as { __realGet?: unknown };
      w.__realGet ??= area.get;
      area.get =
        m === 'reject'
          ? () => Promise.reject(new Error('Simulated read failure'))
          : m === 'corrupt'
            ? () => Promise.resolve({ [key as string]: { schemaVersion: 1, revision: 3, cases: [{ id: 'broken' }] } })
            : w.__realGet;
    },
    [mode, STORE_KEY] as const,
  );
}

export async function openSummary(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Prepare case summary…' }).click();
  await expect(page.getByRole('heading', { name: 'Case summary preview' })).toBeFocused();
  await expect(page.getByTestId('export-text')).toHaveValue(/REFUND RECORD SUMMARY/);
}


type GateWindow = Window & {
  __realGet?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  __readGate?: { held: boolean; release: () => void };
  __realWrite?: (text: string) => Promise<void>;
  __clip?: { calls: number; written: string[]; pending: { resolve: () => void; reject: (e: unknown) => void } | null };
};

/**
 * Holds the page's NEXT chrome.storage.local.get result after the real API has
 * read it, until releaseHeldRead(). Later reads (e.g. the dashboard's
 * change-triggered refresh) pass straight through to the real API.
 */
export async function holdNextRead(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as GateWindow;
    const area = chrome.storage.local as unknown as { get: (...args: unknown[]) => Promise<Record<string, unknown>> };
    w.__realGet ??= area.get;
    const real = w.__realGet;
    const gate: { held: boolean; release: () => void } = { held: false, release: () => undefined };
    w.__readGate = gate;
    let armed = true;
    area.get = async (...args: unknown[]) => {
      const result = await real.apply(chrome.storage.local, args);
      if (armed) {
        armed = false;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
          gate.held = true;
        });
      }
      return result;
    };
  });
}

export async function waitForHeldRead(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as GateWindow).__readGate?.held === true)).toBe(true);
}

export async function releaseHeldRead(page: Page): Promise<void> {
  await page.evaluate(() => (window as GateWindow).__readGate?.release());
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
