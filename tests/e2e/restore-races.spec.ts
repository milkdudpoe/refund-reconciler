// Task 04.1 regressions: restore requests that outlive an erase, and
// completion freshness when a successful reply is delayed. Requests are
// captured from the real Restore UI; sends, replies and reads are gated
// deterministically in test code; the real worker and storage decide.

import type { Page } from '@playwright/test';
import { expect, itemCard, recordForItem, test, type ExtensionSession } from './fixtures';
import { holdNextRead, overridePageReads, releaseHeldRead, seed, storedRaw, waitForHeldRead } from './export-helpers';
import {
  approveButton,
  chooseBackup,
  destination,
  envelopeOf,
  eraseViaUi,
  expectEligible,
  expectErased,
  holdNextReply,
  holdNextSend,
  openRestore,
  recordSends,
  releaseSend,
  restorePanel,
  scratchDir,
  sendRaw,
  sentRequests,
  waitForHeldSend,
  writeBackupFile,
} from './restore-helpers';
import { richLedger } from '../shared/rich-ledger';

type Raw = { revision: number; cases: { id: string; entries: { note: string }[] }[]; ledgerEpoch?: string; lastRestore?: { operationId: string; restoredRevision: number } };

let scratch: Awaited<ReturnType<typeof scratchDir>>;
test.beforeEach(async () => {
  scratch = await scratchDir();
});
test.afterEach(async () => {
  await scratch.cleanup();
});

const corrupt = (page: Page) => seed(page, { schemaVersion: 1, revision: 1, cases: [{ id: 'broken' }] });

async function preview(session: ExtensionSession, store: unknown = richLedger(), name = 'rich.json'): Promise<Page> {
  const page = await session.openDashboard();
  await openRestore(page);
  await chooseBackup(page, await writeBackupFile(scratch.dir, name, envelopeOf(store)));
  await expectEligible(page);
  return page;
}

test.describe('restore requests cannot outlive an erase', () => {
  test('a committed first restore, replayed verbatim after several erase cycles and a browser restart, never resurrects', async ({ session }) => {
    const a = await preview(session);
    await recordSends(a);
    await approveButton(a).click(); // the real Restore UI builds and sends the request
    await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const [original] = await sentRequests(a);
    expect(original).toMatchObject({ kind: 'restore', expected: { revision: 0, stored: false, epoch: null } });
    expect(((await storedRaw(a)) as Raw).cases).toHaveLength(4);

    const b = await session.openDashboard();
    const epochs: string[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await eraseViaUi(b, corrupt);
      epochs.push(expectErased(await storedRaw(b)));
      // The exact original request, with its original token, sent again unchanged.
      expect(await sendRaw(b, original)).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
      expect(expectErased(await storedRaw(b))).toBe(epochs[cycle]);
    }
    expect(new Set(epochs).size).toBe(3);

    // The protection is in storage: it survives a full browser/profile restart.
    await session.close();
    await session.launch();
    const c = await session.openDashboard();
    await expect(c.getByTestId('empty-state')).toBeVisible();
    expect(await sendRaw(c, original)).toMatchObject({ ok: false, error: { code: 'restore_stale' } });
    expect(expectErased(await storedRaw(c))).toBe(epochs[2]);

    // A fresh read and an explicit new approval restore exactly once.
    await openRestore(c);
    await recordSends(c);
    await chooseBackup(c, await writeBackupFile(scratch.dir, 'again.json', envelopeOf(richLedger())));
    await expectEligible(c);
    await expect(destination(c)).toContainText('revision 0');
    await approveButton(c).click();
    await expect(c.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const [fresh] = await sentRequests(c);
    expect(fresh?.operationId).not.toBe(original?.operationId);
    expect(fresh).toMatchObject({ expected: { revision: 0, stored: true, epoch: epochs[2] } });
    const restored = (await storedRaw(c)) as Raw;
    expect(restored).toMatchObject({ revision: 1, ledgerEpoch: epochs[2], lastRestore: { operationId: fresh?.operationId } });
    expect(await sendRaw(c, fresh)).toMatchObject({ ok: true, outcome: 'duplicate' });
    expect(await sendRaw(c, original)).toMatchObject({ ok: false });
    expect(await storedRaw(c)).toEqual(restored);
  });

  test('a first restore held before delivery while another view creates data and erases it is refused when released', async ({ session }) => {
    const a = await preview(session);
    await holdNextSend(a);
    await approveButton(a).click();
    await waitForHeldSend(a);
    const [held] = await sentRequests(a);
    expect(held).toMatchObject({ expected: { revision: 0, stored: false, epoch: null } });

    // Another dashboard creates data, then erases it twice through the real UI.
    const b = await session.openDashboard();
    await b.getByRole('button', { name: 'Load synthetic demo' }).click();
    await expect(b.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2);
    await expect(a.getByTestId('demo-cases').getByTestId('case-row')).toHaveCount(2); // A received the events
    await eraseViaUi(b, corrupt);
    await eraseViaUi(b, corrupt);
    const erased = await storedRaw(b);
    expectErased(erased);
    await expect(a.getByTestId('empty-state')).toBeVisible();
    await expect(restorePanel(a)).toHaveAttribute('data-phase', 'sending');

    // Release the original send: the worker refuses it; nothing is restored.
    await releaseSend(a);
    await expect(a.getByTestId('restore-feedback')).toContainText('Not restored. Saved data changed after this restore was approved');
    expect(await storedRaw(b)).toEqual(erased);

    // A new explicit approval against the fresh destination succeeds once.
    await expectEligible(a);
    await approveButton(a).click();
    await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    const requests = await sentRequests(a);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.operationId).not.toBe(held?.operationId);
    expect(((await storedRaw(a)) as Raw).lastRestore?.operationId).toBe(requests[1]?.operationId);
    // Replayed now, the held request is still refused (the ledger now holds the new restore).
    expect(await sendRaw(a, held)).toMatchObject({ ok: false, error: { code: 'restore_not_empty' } });
  });
});

test.describe('a delayed successful reply keeps completion truthful about later changes', () => {
  /** Approves, lets the real worker commit, and holds the successful reply. */
  async function commitAndHoldReply(a: Page): Promise<void> {
    await holdNextReply(a);
    await approveButton(a).click();
    await waitForHeldSend(a);
    await expect(restorePanel(a)).toHaveAttribute('data-phase', 'sending');
  }

  test('no later change: the restore’s own write does not count as a change', async ({ session }) => {
    const a = await preview(session);
    await commitAndHoldReply(a);
    await expect(a.getByTestId('case-row')).toHaveCount(4); // A processed the restore's own event
    await releaseSend(a);
    await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await expect(a.getByTestId('restore-freshness')).toHaveAttribute('data-freshness', 'current');
    await expect(a.getByTestId('restore-changed-since')).toHaveCount(0);
    expect(((await storedRaw(a)) as Raw).revision).toBe(1);
  });

  test('a later entry, then a deletion of the restored case, then an erase', async ({ session }) => {
    for (const change of ['entry', 'delete', 'erase'] as const) {
      // A fresh empty profile state for each variant.
      const reset = await session.openDashboard();
      await reset.evaluate((key) => chrome.storage.local.remove(key), 'refundReconciler.store');
      await reset.close();
      const single = { schemaVersion: 1, revision: 3, cases: [richLedger().cases[1]] };
      const a = await preview(session, single, `${change}.json`);
      await commitAndHoldReply(a);
      const b = await session.openDashboard();
      const committed = (await storedRaw(b)) as Raw;
      expect(committed.revision).toBe(1);
      if (change === 'entry') {
        await b.getByTestId('case-row').filter({ hasText: 'Synthetic chair' }).click();
        await recordForItem(b, 'Synthetic chair', 'Record recharge', '5', { note: 'later entry' });
        await a.getByTestId('case-row').filter({ hasText: 'Synthetic chair' }).click();
        await expect(itemCard(a, 'Synthetic chair').getByTestId('item-net')).toHaveText('$85.00');
      } else if (change === 'delete') {
        await b.getByTestId('case-row').filter({ hasText: 'Synthetic chair' }).click();
        await b.getByRole('button', { name: 'Delete case…' }).click();
        await b.getByRole('button', { name: 'Permanently delete' }).click();
        await expect(a.getByTestId('empty-state')).toBeVisible();
        expect(((await storedRaw(b)) as Raw).revision).toBe(2);
      } else {
        await eraseViaUi(b, corrupt);
        await expect(a.getByTestId('empty-state')).toBeVisible();
      }
      // All events reached A before its reply: still sending, no completion shown yet.
      await expect(restorePanel(a)).toHaveAttribute('data-phase', 'sending');
      await expect(a.getByTestId('restore-done')).toHaveCount(0);
      const afterChange = await storedRaw(b);
      await releaseSend(a);
      await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
      await expect(a.getByTestId('restore-done')).toContainText('revision 1');
      await expect(a.getByTestId('restore-changed-since')).toContainText('may no longer match the backup');
      expect(await storedRaw(b)).toEqual(afterChange); // no further restore write
      if (change === 'entry') expect((afterChange as Raw).cases[0]?.entries.filter((e) => e.note === 'later entry')).toHaveLength(1);
      await a.close();
      await b.close();
    }
  });

  test('a failed freshness read leaves completion intact but unverified', async ({ session }) => {
    const a = await preview(session);
    await commitAndHoldReply(a);
    await overridePageReads(a, 'reject');
    await releaseSend(a);
    await expect(a.getByTestId('restore-done')).toHaveAttribute('data-outcome', 'applied');
    await expect(a.getByTestId('restore-freshness')).toHaveAttribute('data-freshness', 'unverified');
    await expect(a.getByTestId('restore-freshness')).toContainText('could not be verified');
    // Once reads work and a change arrives, the change is reported.
    await overridePageReads(a, 'real');
    const b = await session.openDashboard();
    await b.getByRole('button', { name: 'Remove synthetic demo' }).click();
    await expect(a.getByTestId('restore-changed-since')).toBeVisible();
  });

  test('a held freshness read overtaken by a change cannot establish freshness or clear the warning', async ({ session }) => {
    const a = await preview(session);
    await commitAndHoldReply(a);
    await holdNextRead(a); // the completion read: it will see the unchanged restore, then be held
    await releaseSend(a);
    await waitForHeldRead(a);
    await expect(a.getByTestId('restore-freshness')).toHaveAttribute('data-freshness', 'checking');
    const b = await session.openDashboard();
    await b.getByRole('button', { name: 'Remove synthetic demo' }).click();
    await expect(a.getByTestId('restore-changed-since')).toBeVisible();
    const after = await storedRaw(b);
    await releaseHeldRead(a); // the old "unchanged" result arrives late
    await expect(a.getByTestId('restore-changed-since')).toBeVisible();
    await expect(a.getByTestId('restore-freshness')).toHaveCount(0);
    expect(await storedRaw(b)).toEqual(after);
    expect(((after as Raw).lastRestore)?.restoredRevision).toBe(1);
  });
});
