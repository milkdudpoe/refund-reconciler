// Task 04: restoring a local backup into an empty ledger, through the built
// extension's real dashboard, real file input, real browser downloads, real
// service worker messaging and real chrome.storage.local. Gates and faults are
// injected from this test code only.

import type { Page } from '@playwright/test';
import { createCase, expect, itemCard, recordForItem, test, type ExtensionSession } from './fixtures';
import { holdNextRead, overridePageReads, releaseHeldRead, seed, storedRaw, waitForHeldRead } from './export-helpers';
import {
  approveButton,
  chooseBackup,
  destination,
  dropNextSend,
  envelopeOf,
  expectErased,
  expectEligible,
  failWorkerReads,
  holdNextSend,
  launchProfile,
  loseNextReply,
  openRestore,
  rejectNextWorkerWrite,
  releaseSend,
  restorePanel,
  saveBackupDownload,
  scratchDir,
  sendRaw,
  sentOperationIds,
  waitForHeldSend,
  writeBackupFile,
} from './restore-helpers';
import { summarizeCase } from '../../src/domain/reconcile';
import { decideRestore } from '../../src/domain/restore';
import { emptyStore, type CaseRecord, type StoreData } from '../../src/domain/types';
import { parseBackupEnvelope, parseStore } from '../../src/domain/validate';
import { analyzeExcerpt } from '../../src/capture/parse';
import { HISTORICAL_REFUSED_EXCERPT, HOSTILE_LABEL, HOSTILE_NOTE, richLedger } from '../shared/rich-ledger';

let scratch: Awaited<ReturnType<typeof scratchDir>>;
test.beforeEach(async () => {
  scratch = await scratchDir();
});
test.afterEach(async () => {
  await scratch.cleanup();
});

function asStore(raw: unknown): StoreData {
  const p = parseStore(raw);
  if (p.status !== 'ok') throw new Error(`store is ${p.status}`);
  return p.store;
}

type Raw = { revision: number; cases: unknown[]; lastRestore?: { operationId: string; restoredRevision: number; caseCount: number; sourceRevision: number; sourceExportedAt: string } };

/** A backup file of the rich synthetic ledger (written by test code). */
async function richFile(name = 'rich.json'): Promise<string> {
  return writeBackupFile(scratch.dir, name, envelopeOf(richLedger()));
}

/** An empty dashboard with the rich backup previewed and eligible. */
async function previewRich(session: ExtensionSession): Promise<Page> {
  const page = await session.openDashboard();
  await openRestore(page);
  await chooseBackup(page, await richFile());
  await expect(page.getByTestId('restore-real-count')).toHaveText('2');
  await expectEligible(page);
  return page;
}

test('acceptance 1, 2 and 11: a real exported file restores into a second empty profile and re-exports with full history', async ({ session }) => {
  // Profile A: a rich synthetic ledger, exported through the real Download JSON flow.
  const source = richLedger();
  let a = await session.openDashboard();
  await seed(a, source);
  await a.close();
  a = await session.openDashboard();
  await expect(a.getByTestId('case-row')).toHaveCount(4);
  await a.getByRole('button', { name: 'Download all data (JSON)…' }).click();
  await expect(a.getByTestId('export-real-count')).toHaveText('2');
  const exported = await saveBackupDownload(a, scratch.dir);
  const sourceNet = await itemNet(a, 'Order 112-1234567-7654321');

  // Profile B: a second, empty extension profile.
  const b = await launchProfile();
  try {
    const page = await b.session.openDashboard();
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await page.getByRole('button', { name: 'Restore from a JSON backup…' }).click();
    await expect(page.getByRole('heading', { name: 'Restore from JSON backup' })).toBeFocused();
    await chooseBackup(page, exported.path);

    // Preview: identification, counts, demo labels; nothing written yet.
    await expect(page.getByTestId('restore-file-name')).toContainText(exported.name);
    await expect(page.getByTestId('restore-real-count')).toHaveText('2');
    await expect(page.getByTestId('restore-demo-count')).toHaveText('2');
    await expect(page.getByTestId('restore-entry-count')).toContainText('(1 void)');
    await expect(page.getByTestId('restore-capture-count')).toHaveText('3');
    await expect(page.getByTestId('restore-demo-note')).toContainText('stay marked as synthetic');
    await expect(page.getByTestId('restore-case')).toHaveCount(4);
    await expect(restorePanel(page)).toContainText('Restoring is not verification that any money was received');
    await expect(restorePanel(page)).toContainText('not signed by Amazon');
    await expectEligible(page);
    expect(await storedRaw(page)).toBeUndefined();

    await approveButton(page).click();
    await expect(page.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await expect(page.getByTestId('restore-done')).toContainText('4 cases');
    await expect(page.getByTestId('restore-done')).toContainText('revision 1');

    // Stored data: every original case, item and entry exactly; only the revision and receipt are new.
    const stored = (await storedRaw(page)) as Raw;
    expect(stored.cases).toEqual(source.cases);
    expect(stored.revision).toBe(1);
    expect(stored.lastRestore).toMatchObject({ restoredRevision: 1, caseCount: 4, sourceRevision: source.revision });
    expect(Object.keys(stored).sort()).toEqual(['cases', 'lastRestore', 'revision', 'schemaVersion']);

    // Calculated state matches the source, including the historical capture the current parser refuses.
    expect(analyzeExcerpt(HISTORICAL_REFUSED_EXCERPT).issued).toBeNull();
    const before = asStore(source).cases.map(summarizeCase);
    expect(asStore(stored).cases.map(summarizeCase)).toEqual(before);
    const hist = (asStore(stored).cases[0] as CaseRecord).entries.find((e) => e.id === 'cap-hist');
    expect(hist).toMatchObject({ amountCents: 3500, recordedAt: '2026-10-03T00:00:00.000Z', capture: { parserVersion: 'amazon-us-selection-1', excerpt: HISTORICAL_REFUSED_EXCERPT } });
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('button', { name: 'Restore from a JSON backup…' })).toHaveCount(0);
    await expect(page.getByTestId('case-row')).toHaveCount(4);
    expect(await itemNet(page, 'Order 112-1234567-7654321')).toEqual(sourceNet);
    await expect(itemCard(page, 'Synthetic lamp').getByTestId('item-reported')).toHaveText('$35.00');
    await expect(itemCard(page, 'Synthetic lamp').getByTestId('item-expected')).toHaveText('Unknown');
    await expect(page.getByTestId('timeline-entry').filter({ hasText: 'Voided' }).first()).toBeVisible();
    await page.getByRole('button', { name: '← All cases' }).click();

    // Re-export from B: a real download that validates and keeps the full history portable.
    await page.getByRole('button', { name: 'Download all data (JSON)…' }).click();
    await expect(page.getByTestId('export-real-count')).toHaveText('2');
    const again = await saveBackupDownload(page, scratch.dir);
    const reparsed = parseBackupEnvelope(JSON.parse(await (await import('node:fs/promises')).readFile(again.path, 'utf8')));
    if (!reparsed.ok) throw new Error(reparsed.error);
    expect(JSON.parse(JSON.stringify(reparsed.value.store.cases))).toEqual(source.cases);
    expect(reparsed.value.store.lastRestore?.operationId).toBe(stored.lastRestore?.operationId);
    // It can itself be restored into another empty ledger, where the old receipt is not carried over.
    const next = decideRestore(emptyStore(), false, { operationId: 'next-op', expected: { revision: 0, stored: false, epoch: null }, backup: reparsed.value }, 'a'.repeat(64), '2026-10-10T00:00:00.000Z');
    expect(next.kind === 'write' && next.store.lastRestore?.operationId).toBe('next-op');
  } finally {
    await b.close();
  }
});

async function itemNet(page: Page, caseTitle: string): Promise<string[]> {
  await page.getByTestId('case-row').filter({ hasText: caseTitle }).click();
  const values = await page.getByTestId('item-net').allTextContents();
  return values;
}

test('acceptance 3: preview, cancel and file replacement write nothing; hostile text is literal; an empty backup is a no-op', async ({ session }) => {
  const page = await session.openDashboard();
  await openRestore(page);
  await chooseBackup(page, await richFile('first.json'));
  await expectEligible(page);

  // Hostile labels and notes render as literal text; private details are collapsed.
  await expect(page.getByTestId('restore-cases')).toContainText(HOSTILE_LABEL);
  await expect(page.getByTestId('restore-private')).not.toHaveAttribute('open', '');
  await expect(page.getByText(HOSTILE_NOTE)).toBeHidden();
  await page.getByText(/Show notes, references and captured excerpts/).click();
  await expect(page.getByText(HOSTILE_NOTE, { exact: false })).toBeVisible();
  await expect(page.getByTestId('restore-private')).toContainText(HISTORICAL_REFUSED_EXCERPT);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('a[href]').count()).toBe(0); // source paths are never made clickable

  // Replacing the file re-validates and re-previews the new one.
  const demoOnly = { ...richLedger(), cases: richLedger().cases.filter((c) => (c as { isDemo: boolean }).isDemo) };
  // A hostile file name is not a valid path on every OS, so this file is supplied in memory through the real input.
  await page.getByLabel('Backup file (.json)').setInputFiles({
    name: '<b>second<i>.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(envelopeOf(demoOnly))),
  });
  await expect(page.getByTestId('restore-file-name')).toContainText('<b>second<i>.json');
  expect(await page.locator('[data-testid="restore-file-name"] b, [data-testid="restore-file-name"] i').count()).toBe(0);
  await expect(page.getByTestId('restore-real-count')).toHaveText('0');
  await expect(page.getByTestId('restore-demo-count')).toHaveText('2');
  await expect(approveButton(page)).toHaveText('Restore 2 cases');
  await expectEligible(page);

  // Cancel discards the file and returns focus; nothing was written.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(restorePanel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Restore from JSON…' })).toBeFocused();
  expect(await storedRaw(page)).toBeUndefined();

  // Escape also closes without writing.
  await openRestore(page);
  await chooseBackup(page, await richFile('third.json'));
  await expectEligible(page);
  await page.keyboard.press('Escape');
  await expect(restorePanel(page)).toHaveCount(0);
  expect(await storedRaw(page)).toBeUndefined();

  // A valid backup with no cases is an informative no-op.
  await openRestore(page);
  await chooseBackup(page, await writeBackupFile(scratch.dir, 'empty.json', envelopeOf({ schemaVersion: 1, revision: 6, cases: [] })));
  await expect(page.getByTestId('restore-empty-backup')).toContainText('nothing to restore');
  await expect(approveButton(page)).toHaveCount(0);
  expect(await storedRaw(page)).toBeUndefined();
  // Also at the worker: nothing written, revision unchanged.
  expect(await sendRaw(page, { kind: 'restore', operationId: 'empty-op', expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf({ schemaVersion: 1, revision: 6, cases: [] }) })).toEqual({ ok: true, outcome: 'unchanged', revision: 0 });
  expect(await storedRaw(page)).toBeUndefined();
});

test('acceptance 4: invalid files give useful errors and no write; forged worker messages are validated too', async ({ session }) => {
  const page = await session.openDashboard();
  await openRestore(page);
  const mutate = (fn: (s: ReturnType<typeof richLedger>) => void) => {
    const s = richLedger();
    fn(s);
    return envelopeOf(s);
  };
  const entries = (s: ReturnType<typeof richLedger>, i = 0) => (s.cases[i] as { entries: Record<string, unknown>[] }).entries;
  const cases: [string, unknown, RegExp][] = [
    ['malformed.json', '{"format": "refund-reconciler-backup", ', /not valid JSON/],
    ['not-backup.json', { hello: 'world' }, /not a Refund Reconciler backup/],
    ['version.json', { ...envelopeOf(richLedger()), formatVersion: 2 }, /format version 2/],
    ['extra.json', { ...envelopeOf(richLedger()), run: 'alert(1)' }, /unexpected field/],
    ['ledger-version.json', envelopeOf({ schemaVersion: 7, revision: 1, cases: [] }), /schema version 7/],
    ['timestamp.json', { ...envelopeOf(richLedger()), exportedAt: 'last week' }, /exportedAt/],
    ['money.json', mutate((s) => { entries(s)[1]!.amountCents = 19.99; }), /amountCents/],
    ['dupe.json', mutate((s) => { entries(s, 1).push({ ...entries(s, 1)[1]! }); }), /duplicate entry id/],
    ['void.json', mutate((s) => { entries(s).find((e) => e.id === 'v1')!.targetEntryId = 'e2'; }), /targetEntryId/],
    ['provenance.json', mutate((s) => { (entries(s).find((e) => e.id === 'cap-new')!.capture as Record<string, unknown>).approvedAmountText = '$99.00'; }), /approvedAmountText/],
  ];
  for (const [name, content, message] of cases) {
    await chooseBackup(page, await writeBackupFile(scratch.dir, name, content));
    await expect(page.getByTestId('restore-invalid')).toContainText(message);
    await expect(page.getByTestId('restore-invalid')).toContainText('Nothing was changed');
    await expect(approveButton(page)).toHaveCount(0);
  }
  // Not UTF-8.
  await chooseBackup(page, await writeBackupFile(scratch.dir, 'binary.json', new Uint8Array([0xff, 0xfe, 0x00, 0x7b])));
  await expect(page.getByTestId('restore-invalid')).toContainText('not UTF-8 text');
  // Oversized: rejected from the file size, before reading.
  const big = await writeBackupFile(scratch.dir, 'huge.json', new Uint8Array(25 * 1024 * 1024 + 1).fill(0x20));
  await chooseBackup(page, big);
  await expect(page.getByTestId('restore-invalid')).toContainText('the largest backup this dashboard reads is 25.0 MiB');
  expect(await storedRaw(page)).toBeUndefined();

  // Forged messages straight to the real service worker are validated there.
  const forged: unknown[] = [
    { kind: 'restore', operationId: 'f1', expected: { revision: 0, stored: false, epoch: null }, backup: mutate((s) => { entries(s)[1]!.amountCents = -5; }) },
    { kind: 'restore', operationId: 'f2', expected: { revision: 0, stored: false, epoch: null }, backup: mutate((s) => { s.cases.push(structuredClone(s.cases[0]!)); }) },
    { kind: 'restore', operationId: 'f3', expected: { revision: 0, stored: false, epoch: null }, backup: mutate((s) => { entries(s).find((e) => e.id === 'v1')!.targetEntryId = 'missing'; }) },
    { kind: 'restore', operationId: 'f4', expected: { revision: 0, stored: false, epoch: null }, backup: mutate((s) => { (entries(s).find((e) => e.id === 'cap-new')!.capture as Record<string, unknown>).sourceOrigin = 'https://evil.example'; }) },
    { kind: 'restore', operationId: 'f5', expected: { revision: 0, stored: false, epoch: null }, backup: { ...envelopeOf(richLedger()), formatVersion: 3 } },
    { kind: 'restore', operationId: '../f6', expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(richLedger()) },
    { kind: 'restore', operationId: 'f7', backup: envelopeOf(richLedger()) },
  ];
  for (const msg of forged) {
    expect(await sendRaw(page, msg)).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
  }
  expect(await storedRaw(page)).toBeUndefined();
});

test('acceptance 5: existing cases (even demo-only) block restore; corrupt, unsupported and unreadable storage are never overwritten', async ({ session }) => {
  const page = await session.openDashboard();
  await page.getByRole('button', { name: 'Load synthetic demo' }).click();
  await expect(page.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
  const demoState = await storedRaw(page);
  await openRestore(page);
  await chooseBackup(page, await richFile());
  await expect(destination(page)).toHaveAttribute('data-state', 'not_empty');
  await expect(destination(page)).toContainText('2 synthetic demo cases');
  await expect(destination(page)).toContainText('never merges with, replaces or deletes');
  await expect(approveButton(page)).toBeDisabled();
  expect(await sendRaw(page, { kind: 'restore', operationId: 'over-demo', expected: { revision: (demoState as Raw).revision, stored: true, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({
    ok: false,
    error: { code: 'restore_not_empty' },
  });
  expect(await storedRaw(page)).toEqual(demoState);

  // Removing the demo separately makes the ledger empty; restore stays a separate, explicit step.
  await page.getByRole('button', { name: 'Remove synthetic demo' }).click();
  await expectEligible(page);
  expect(((await storedRaw(page)) as Raw).cases).toEqual([]);

  // Corrupt and unsupported destination data: blocked in the panel and at the worker; never reset.
  for (const bad of [
    { schemaVersion: 1, revision: 1, cases: [{ id: 'c', amountCents: 1.5 }] },
    { schemaVersion: 99, revision: 5, cases: [] },
  ]) {
    await seed(page, bad);
    await expect(destination(page)).toHaveAttribute('data-state', 'blocked');
    await expect(destination(page)).toContainText('never treats unreadable data as empty');
    await expect(approveButton(page)).toBeDisabled();
    await expect(page.getByTestId('unreadable')).toBeVisible();
    for (const stored of [true, false]) {
      const res = await sendRaw(page, { kind: 'restore', operationId: 'over-bad', expected: { revision: 0, stored, epoch: null }, backup: envelopeOf(richLedger()) });
      expect(res.ok).toBe(false);
      expect(['storage_unreadable', 'storage_unsupported']).toContain(res.error?.code);
    }
    expect(await storedRaw(page)).toEqual(bad);
  }

  // Failed reads: the dashboard's fresh check and the worker's own read both block.
  await page.evaluate((key) => chrome.storage.local.remove(key), 'refundReconciler.store');
  await expectEligible(page);
  await overridePageReads(page, 'reject');
  await page.evaluate((key) => chrome.storage.local.set({ [key]: { schemaVersion: 1, revision: 0, cases: [] } }), 'refundReconciler.store');
  await expect(destination(page)).toHaveAttribute('data-state', 'blocked');
  await expect(destination(page)).toContainText('Simulated read failure');
  await expect(approveButton(page)).toBeDisabled();
  await overridePageReads(page, 'real');
  await failWorkerReads(session, true);
  expect(await sendRaw(page, { kind: 'restore', operationId: 'read-fail', expected: { revision: 0, stored: true, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({
    ok: false,
    error: { code: 'storage_error' },
  });
  await failWorkerReads(session, false);
  expect(await storedRaw(page)).toEqual({ schemaVersion: 1, revision: 0, cases: [] });
});

test('acceptance 6: a case created in another dashboard after preview pauses approval at event time and the worker refuses the stale attempt', async ({ session }) => {
  const a = await previewRich(session);
  const b = await session.openDashboard();

  // Hold A's change-triggered destination read after it has read the new data.
  await holdNextRead(a);
  await createCase(b, { orderRef: 'LATE-1', items: [{ label: 'Lamp', amount: '20' }] });
  await waitForHeldRead(a); // A has processed the change event
  // Captured before the revalidation result is delivered:
  await expect(destination(a)).toHaveAttribute('data-state', 'checking');
  await expect(approveButton(a)).toBeDisabled();
  const afterB = await storedRaw(b);

  // A stale attempt sent to the worker (as an old approval would) is refused there.
  expect(await sendRaw(a, { kind: 'restore', operationId: 'stale-op', expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({
    ok: false,
    error: { code: 'restore_not_empty' },
  });
  await releaseHeldRead(a);
  await expect(destination(a)).toHaveAttribute('data-state', 'not_empty');
  await expect(approveButton(a)).toBeDisabled();
  expect(await storedRaw(a)).toEqual(afterB);

  // The case is deleted again: still a fresh approval against the new state (revision moved on).
  await b.getByRole('button', { name: 'Delete case…' }).click();
  await b.getByRole('button', { name: 'Permanently delete' }).click();
  await expectEligible(a);
  await expect(destination(a)).toContainText('revision 2');
  expect(await sendRaw(a, { kind: 'restore', operationId: 'stale-op', expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({
    ok: false,
    error: { code: 'restore_stale' },
  });
  expect(((await storedRaw(a)) as Raw).cases).toEqual([]);
});

test('acceptance 6: a restore already approved and in flight is refused by the worker when a case appears first', async ({ session }) => {
  const a = await previewRich(session);
  const b = await session.openDashboard();
  await holdNextSend(a);
  await approveButton(a).click();
  await waitForHeldSend(a);
  await expect(restorePanel(a)).toHaveAttribute('data-phase', 'sending');
  await expect(a.getByLabel('Backup file (.json)')).toBeDisabled();
  await createCase(b, { orderRef: 'FIRST-1', items: [{ label: 'Desk', amount: '80' }] });
  const afterB = await storedRaw(b);
  await releaseSend(a);
  await expect(a.getByTestId('restore-feedback')).toContainText('Not restored. Saved data now contains 1 case');
  await expect(destination(a)).toHaveAttribute('data-state', 'not_empty');
  expect(await storedRaw(a)).toEqual(afterB);
});

test('acceptance 7: two concurrent restores serialise: one complete ledger, no mix, the other refused', async ({ session }) => {
  const a = await previewRich(session);
  const b = await session.openDashboard();
  await openRestore(b);
  const other = { schemaVersion: 1, revision: 2, cases: [richLedger().cases[1]] };
  await chooseBackup(b, await writeBackupFile(scratch.dir, 'other.json', envelopeOf(other)));
  await expectEligible(b);

  await holdNextSend(a);
  await holdNextSend(b);
  await approveButton(a).click();
  await approveButton(b).click();
  await waitForHeldSend(a);
  await waitForHeldSend(b);
  await Promise.all([releaseSend(a), releaseSend(b)]);

  const outcomes = await Promise.all(
    [a, b].map(async (p) => {
      await expect(p.getByTestId('restore-done').or(p.getByTestId('restore-feedback'))).toBeVisible();
      return (await p.getByTestId('restore-done').count()) > 0 ? 'done' : 'refused';
    }),
  );
  expect(outcomes.sort()).toEqual(['done', 'refused']);
  const stored = (await storedRaw(a)) as Raw;
  const winner = outcomes[0] === 'done' ? 'a' : 'b';
  expect(stored.revision).toBe(1);
  expect(stored.cases).toEqual(winner === 'a' ? richLedger().cases : other.cases);
  const winnerPage = winner === 'a' ? a : b;
  expect(stored.lastRestore?.operationId).toBe((await sentOperationIds(winnerPage))[0]);
});

test('acceptance 8: a committed restore with a lost reply and failing reads stays uncertain, then recovers by its operation id', async ({ session }) => {
  const a = await previewRich(session);
  await loseNextReply(a);
  await overridePageReads(a, 'reject');
  await approveButton(a).click();
  await expect(restorePanel(a)).toHaveAttribute('data-phase', 'uncertain');
  await expect(a.getByTestId('restore-feedback')).toContainText('saved data cannot be read right now. Its outcome is unknown');
  await expect(a.getByTestId('restore-done')).toHaveCount(0);
  const [opId] = await sentOperationIds(a);

  // Another dashboard adds a later entry to a restored case.
  const b = await session.openDashboard();
  await b.getByTestId('case-row').filter({ hasText: 'Synthetic chair' }).click();
  await recordForItem(b, 'Synthetic chair', 'Record recharge', '5', { note: 'later entry' });
  const afterB = (await storedRaw(b)) as Raw;
  expect(afterB.lastRestore?.operationId).toBe(opId);
  expect(afterB.revision).toBe(2);

  // Retrying while reads fail and data has changed does not resend.
  await a.getByRole('button', { name: 'Check and retry restore' }).click();
  await expect(a.getByTestId('restore-feedback')).toContainText('was not resent');
  expect(await sentOperationIds(a)).toEqual([opId]);
  expect(await storedRaw(b)).toEqual(afterB);

  // Reads recover: the operation's own receipt proves the commit; later changes are acknowledged.
  await overridePageReads(a, 'real');
  await a.getByRole('button', { name: 'Check and retry restore' }).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'recovered');
  await expect(a.getByTestId('restore-changed-since')).toContainText('may no longer match the backup');
  await expect(a.getByRole('button', { name: /^Restore \d/ })).toHaveCount(0);
  await expect(a.getByLabel('Backup file (.json)')).toHaveCount(0);

  // An identical retry never duplicates or overwrites: the worker recognises the
  // operation from the receipt in storage, not from memory (restart is covered
  // in tests/unit/restore.test.ts with a fresh handler over the same storage).
  expect(await sendRaw(b, { kind: 'restore', operationId: opId, expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(richLedger()) })).toEqual({ ok: true, outcome: 'duplicate', revision: 2 });
  const final = (await storedRaw(b)) as Raw;
  expect(final).toEqual(afterB);
  const chair = final.cases.find((c) => (c as { id: string }).id === 'real-2') as { entries: { note: string }[] };
  expect(chair.entries.filter((e) => e.note === 'later entry')).toHaveLength(1);
  expect(final.cases).toHaveLength(4);
});

test('acceptance 8: a lost reply with readable storage reports completion from the receipt; an uncommitted lost request retries with the same id', async ({ session }) => {
  // Committed, reply lost, storage readable: completion is proven by the receipt.
  let a = await previewRich(session);
  await loseNextReply(a);
  await approveButton(a).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'recovered');
  await expect(a.getByTestId('restore-done')).toContainText('It was not applied twice');
  const stored = (await storedRaw(a)) as Raw;
  expect(stored.lastRestore?.operationId).toBe((await sentOperationIds(a))[0]);
  await a.close();

  // Not committed (the request never reached the worker), reply lost: uncertain with the same safe retry.
  await (await session.openDashboard()).evaluate((key) => chrome.storage.local.remove(key), 'refundReconciler.store');
  a = await previewRich(session);
  await dropNextSend(a);
  await approveButton(a).click();
  await expect(restorePanel(a)).toHaveAttribute('data-phase', 'uncertain');
  await expect(a.getByTestId('restore-feedback')).toContainText('not in your saved data right now');
  await expect(a.getByTestId('restore-feedback')).toContainText('same operation id');
  expect(await storedRaw(a)).toBeUndefined();
  await a.getByRole('button', { name: 'Check and retry restore' }).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
  const ops = await sentOperationIds(a);
  expect(ops).toHaveLength(2);
  expect(ops[1]).toBe(ops[0]);
  expect(((await storedRaw(a)) as Raw).lastRestore?.operationId).toBe(ops[0]);
});

test('acceptance 9: a rejected write keeps the preview and changes nothing; a later retry succeeds; conflicting reuse is refused', async ({ session }) => {
  const a = await previewRich(session);
  await rejectNextWorkerWrite(session);
  await approveButton(a).click();
  await expect(a.getByTestId('restore-feedback')).toContainText('Not restored: Storage rejected the restore');
  await expect(a.getByTestId('restore-feedback')).toContainText('Your saved data was not changed');
  await expect(a.getByTestId('restore-file-name')).toContainText('rich.json');
  await expect(a.getByTestId('restore-real-count')).toHaveText('2');
  expect(await storedRaw(a)).toBeUndefined();

  await expectEligible(a);
  await approveButton(a).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
  const stored = (await storedRaw(a)) as Raw;
  expect(stored.cases).toEqual(richLedger().cases);

  const changed = richLedger();
  (changed.cases[1] as { entries: Record<string, unknown>[] }).entries[1]!.amountCents = 1;
  expect(await sendRaw(a, { kind: 'restore', operationId: stored.lastRestore!.operationId, expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(changed) })).toMatchObject({
    ok: false,
    error: { code: 'conflict' },
  });
  expect(await storedRaw(a)).toEqual(stored);
});

test('acceptance 10: after deletion or erase, a delayed retry cannot resurrect records; a new restore needs new approval', async ({ session }) => {
  // Deletion: the receipt stays with the ledger, so the old operation is recognised, not re-applied.
  let a = await previewRich(session);
  await loseNextReply(a);
  await overridePageReads(a, 'reject');
  await approveButton(a).click();
  await expect(restorePanel(a)).toHaveAttribute('data-phase', 'uncertain');
  const [firstOp] = await sentOperationIds(a);
  const b = await session.openDashboard();
  for (const title of ['Order 112-1234567-7654321', 'Synthetic chair']) {
    await b.getByTestId('case-row').filter({ hasText: title }).click();
    await b.getByRole('button', { name: 'Delete case…' }).click();
    await b.getByRole('button', { name: 'Permanently delete' }).click();
    await expect(b.getByRole('heading', { name: 'Your cases' })).toBeVisible();
  }
  await b.getByRole('button', { name: 'Remove synthetic demo' }).click();
  await expect(b.getByTestId('empty-state')).toBeVisible();
  const emptied = (await storedRaw(b)) as Raw;
  expect(emptied.cases).toEqual([]);
  await overridePageReads(a, 'real');
  await a.getByRole('button', { name: 'Check and retry restore' }).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'recovered');
  await expect(a.getByTestId('restore-changed-since')).toBeVisible();
  expect(await sendRaw(b, { kind: 'restore', operationId: firstOp, expected: { revision: 0, stored: false, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({ ok: true, outcome: 'duplicate' });
  expect(await storedRaw(b)).toEqual(emptied);
  await a.close();

  // Erase: the ledger and its receipt are gone. The uncertain dashboard withdraws its approval instead of resending.
  a = await previewRich(session); // destination: empty ledger at the current revision
  await loseNextReply(a);
  await overridePageReads(a, 'reject');
  await approveButton(a).click();
  await expect(restorePanel(a)).toHaveAttribute('data-phase', 'uncertain');
  const [secondOp] = await sentOperationIds(a);
  expect(((await storedRaw(b)) as Raw).lastRestore?.operationId).toBe(secondOp);
  await seed(b, { schemaVersion: 1, revision: 1, cases: [{ id: 'broken' }] });
  await b.getByRole('button', { name: 'Erase stored data…' }).click();
  await b.getByRole('button', { name: 'Permanently erase' }).click();
  await expect(b.getByTestId('empty-state')).toBeVisible();
  const erasedEpoch = expectErased(await storedRaw(b));

  await overridePageReads(a, 'real');
  await a.getByRole('button', { name: 'Check and retry restore' }).click();
  await expect(a.getByTestId('restore-feedback')).toContainText('this approval was withdrawn and nothing was resent');
  expect(await sentOperationIds(a)).toEqual([secondOp]);
  expect(expectErased(await storedRaw(a))).toBe(erasedEpoch);
  // The old approval, replayed at the worker, no longer matches the erased destination.
  expect(await sendRaw(b, { kind: 'restore', operationId: secondOp, expected: { revision: emptied.revision, stored: true, epoch: null }, backup: envelopeOf(richLedger()) })).toMatchObject({
    ok: false,
    error: { code: 'restore_stale' },
  });
  expect(expectErased(await storedRaw(a))).toBe(erasedEpoch);

  // A new restore is a new explicit approval against the fresh (erased) destination, with a new id.
  await expectEligible(a);
  await approveButton(a).click();
  await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
  const ops = await sentOperationIds(a);
  expect(ops).toHaveLength(2);
  expect(ops[1]).not.toBe(secondOp);
  expect(((await storedRaw(a)) as Raw).lastRestore?.operationId).toBe(ops[1]);
});

test('an open restore panel keeps unrelated unsaved drafts through storage changes and close', async ({ session }) => {
  const page = await session.openDashboard();
  await createCase(page, { orderRef: 'DRAFT-1', items: [{ label: 'Toaster', amount: '30' }] });
  await page.getByRole('button', { name: '← All cases' }).click();
  await openRestore(page);
  await chooseBackup(page, await richFile());
  await expect(destination(page)).toHaveAttribute('data-state', 'not_empty');
  // Work on a case while the panel stays open.
  await page.getByTestId('case-row').filter({ hasText: 'DRAFT-1' }).click();
  await itemCard(page, 'Toaster').getByRole('button', { name: 'Confirm money received' }).click();
  const amount = page.getByTestId('entry-form').getByRole('textbox', { name: /USD/ });
  await amount.fill('12.34');
  // A change from another dashboard re-checks the destination without touching the draft.
  const b = await session.openDashboard();
  await createCase(b, { orderRef: 'OTHER-1', items: [{ label: 'Rug', amount: '10' }] });
  await expect(destination(page)).toContainText('2 cases of your own');
  await expect(amount).toHaveValue('12.34');
  const before = await storedRaw(page);
  await restorePanel(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(restorePanel(page)).toHaveCount(0);
  expect(await storedRaw(page)).toEqual(before);
  await expect(amount).toHaveValue('12.34');
  await page.getByTestId('entry-form').getByRole('button', { name: 'Save' }).click();
  await expect(itemCard(page, 'Toaster').getByTestId('item-net')).toHaveText('$12.34');
});
