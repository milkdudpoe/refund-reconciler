// Restore browser-test helpers. Gates and fault injection live in test code
// only; the shipped extension has no test switches.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { ExtensionSession, expect } from './fixtures';
import { eraseTyped, setupViaUi } from './vault-helpers';

export async function scratchDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'refund-reconciler-restore-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A second, independent extension profile (empty storage). */
export async function launchProfile(): Promise<{ session: ExtensionSession; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'refund-reconciler-e2e-b-'));
  const session = new ExtensionSession(dir);
  await session.launch();
  return {
    session,
    close: async () => {
      await session.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function envelopeOf(store: unknown, exportedAt = '2026-10-09T08:00:00.000Z'): Record<string, unknown> {
  return { format: 'refund-reconciler-backup', formatVersion: 1, exportedAt, store };
}

export async function writeBackupFile(dir: string, name: string, content: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' || content instanceof Uint8Array ? content : `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

/** Clicks Download JSON in an open data-export panel and saves the real downloaded file. */
export async function saveBackupDownload(page: Page, dir: string): Promise<{ path: string; name: string }> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  const path = join(dir, dl.suggestedFilename());
  await dl.saveAs(path);
  return { path, name: dl.suggestedFilename() };
}

export async function openRestore(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Restore from JSON…' }).click();
  await expect(page.getByRole('heading', { name: 'Restore from JSON backup' })).toBeFocused();
}

export async function chooseBackup(page: Page, path: string): Promise<void> {
  await page.getByLabel('Backup file (.json)').setInputFiles(path);
}

export const restorePanel = (page: Page) => page.getByTestId('restore-panel');
export const destination = (page: Page) => page.getByTestId('restore-destination');
export const approveButton = (page: Page) => page.locator('#restore-approve');

export async function expectEligible(page: Page): Promise<void> {
  await expect(destination(page)).toHaveAttribute('data-state', 'eligible');
  await expect(approveButton(page)).toBeEnabled();
}

type SendWindow = Window & {
  __realSend?: (msg: unknown) => Promise<unknown>;
  __sendModes?: ('hold' | 'holdReply' | 'lose' | 'drop')[];
  __sendGate?: { held: boolean; release: () => void } | undefined;
  __sentOps?: string[];
  __sentMessages?: unknown[];
};

/** Sends a raw message to the real service worker from an extension page (forged requests; bypasses any test wrapper). */
export async function sendRaw(page: Page, message: unknown): Promise<{ ok: boolean; outcome?: string; revision?: number; error?: { code: string; message: string } }> {
  return page.evaluate((m) => {
    const w = window as SendWindow;
    return (w.__realSend ?? chrome.runtime.sendMessage.bind(chrome.runtime))(m) as Promise<never>;
  }, message);
}

/**
 * Wraps the page's chrome.runtime.sendMessage once: every restore operation id
 * sent is recorded, and queued one-shot behaviours apply to the next sends:
 * hold (until releaseSend), lose (delivered and processed, reply lost) or drop
 * (fails before delivery).
 */
function queueSendBehaviour(page: Page, mode: 'hold' | 'holdReply' | 'lose' | 'drop' | null): Promise<void> {
  return page.evaluate((m) => {
    const w = window as SendWindow;
    const rt = chrome.runtime as unknown as { sendMessage: (msg: unknown) => Promise<unknown> };
    if (!w.__realSend) {
      const real = rt.sendMessage.bind(chrome.runtime);
      w.__realSend = real;
      w.__sentOps = [];
      w.__sendModes = [];
      w.__sentMessages = [];
      rt.sendMessage = async (msg: unknown) => {
        // Reads are not changes: they pass straight through and never consume a queued behaviour.
        const kind = (msg as { kind?: unknown } | null)?.kind;
        if (kind === 'read' || kind === 'readLegacy') return real(msg);
        const op = (msg as { operationId?: string }).operationId;
        if (op) {
          w.__sentOps!.push(op);
          // The exact outgoing request, as the dashboard built it (for verbatim replay).
          w.__sentMessages!.push(JSON.parse(JSON.stringify(msg)));
        }
        const behaviour = w.__sendModes!.shift();
        if (behaviour === 'hold') {
          await new Promise<void>((resolve) => {
            w.__sendGate = { held: true, release: resolve };
          });
          return real(msg);
        }
        if (behaviour === 'holdReply') {
          // Delivered and processed by the real worker; only the reply is held.
          const reply = await real(msg);
          await new Promise<void>((resolve) => {
            w.__sendGate = { held: true, release: resolve };
          });
          return reply;
        }
        if (behaviour === 'lose') {
          await real(msg);
          throw new Error('Simulated lost reply');
        }
        if (behaviour === 'drop') throw new Error('Simulated channel failure before delivery');
        return real(msg);
      };
    }
    if (m) w.__sendModes!.push(m);
  }, mode);
}

/** The page's next runtime message is held before it is sent, until releaseSend(). */
export const holdNextSend = (page: Page) => queueSendBehaviour(page, 'hold');
/** The page's next runtime message really reaches the worker and is processed, but its reply is lost. */
export const loseNextReply = (page: Page) => queueSendBehaviour(page, 'lose');
/** The page's next runtime message fails before reaching the worker (the page cannot tell). */
export const dropNextSend = (page: Page) => queueSendBehaviour(page, 'drop');
/** The page's next runtime message is delivered and processed; its (successful) reply is held until releaseSend(). */
export const holdNextReply = (page: Page) => queueSendBehaviour(page, 'holdReply');

/** Records this page's outgoing restore requests without changing them. */
export const recordSends = (page: Page) => queueSendBehaviour(page, null);

/** The exact restore requests this page sent, in order. */
export async function sentRequests(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => ((window as SendWindow).__sentMessages ?? []) as Record<string, unknown>[]);
}

/** A newly protected, never-changed ledger: no cases, revision 0, only its own random marker (nothing was written to it). */
export function expectFreshLedger(raw: unknown): void {
  expect(raw).toEqual({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) });
}

/** Erase (then a new setup) leaves only an empty ledger with an opaque marker: no cases, receipt or other data. */
export function expectErased(raw: unknown): string {
  expect(raw).toEqual({ schemaVersion: 1, revision: 0, cases: [], ledgerEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/) });
  return (raw as { ledgerEpoch: string }).ledgerEpoch;
}

/**
 * Erases through the dashboard's real typed confirmation, then sets up a new
 * passphrase through the real UI, leaving an empty unlocked ledger. Erase is
 * offered for unreadable data (and while locked), so corrupt data is seeded first.
 */
export async function eraseViaUi(page: Page, seedCorrupt: (page: Page) => Promise<void>): Promise<void> {
  await seedCorrupt(page);
  await expect(page.getByTestId('unreadable').or(page.getByTestId('vault-unreadable'))).toBeVisible();
  await eraseTyped(page);
  await setupViaUi(page);
  await expect(page.getByTestId('empty-state')).toBeVisible();
}

/**
 * Returns this profile to a newly protected, empty ledger: an explicit erase
 * through the worker's real protocol, then "Protect your records" through the
 * real UI.
 */
export async function resetToFreshLedger(session: ExtensionSession): Promise<void> {
  const page = await session.openDashboard();
  expect(await sendRaw(page, { kind: 'eraseAll', confirm: 'ERASE ALL REFUND RECONCILER DATA' })).toMatchObject({ ok: true, outcome: 'erased' });
  await setupViaUi(page);
  await page.close();
}

export async function waitForHeldSend(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as SendWindow).__sendGate?.held === true)).toBe(true);
}

export async function releaseSend(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as SendWindow;
    const gate = w.__sendGate;
    w.__sendGate = undefined;
    gate?.release();
  });
}

export async function sentOperationIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as SendWindow).__sentOps ?? []);
}

export function serviceWorker(session: ExtensionSession): Worker {
  // The newest instance is listed last (stopped instances can linger in the list).
  const worker = session.context?.serviceWorkers().filter((w) => w.url().startsWith(`chrome-extension://${session.extensionId}/`)).at(-1);
  if (!worker) throw new Error('no service worker');
  return worker;
}

/** Makes the service worker's next chrome.storage.local.set reject (test-only fault injection). */
export async function rejectNextWorkerWrite(session: ExtensionSession): Promise<void> {
  await serviceWorker(session).evaluate(() => {
    const area = chrome.storage.local as unknown as { set: (items: unknown) => Promise<void> };
    const real = area.set.bind(chrome.storage.local);
    area.set = () => {
      area.set = real;
      return Promise.reject(new Error('Simulated QUOTA_BYTES quota exceeded'));
    };
  });
}

/** Makes the service worker's chrome.storage.local.get reject until restored (test-only). */
export async function failWorkerReads(session: ExtensionSession, fail: boolean): Promise<void> {
  await serviceWorker(session).evaluate((f) => {
    const g = globalThis as unknown as { __realWorkerGet?: unknown };
    const area = chrome.storage.local as unknown as { get: unknown };
    g.__realWorkerGet ??= area.get;
    area.get = f ? () => Promise.reject(new Error('Simulated worker read failure')) : g.__realWorkerGet;
  }, fail);
}
