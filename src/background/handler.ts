// Serialises every write through one queue so concurrent dashboard views can
// never overwrite each other's updates (each command is applied to the latest
// stored state, never to a stale copy held by a page).

import { applyCommand } from '../domain/ledger';
import { decideRestore } from '../domain/restore';
import { parseStore } from '../domain/validate';
import { restorePayloadDigest } from '../export/backup';
import { describeError, eraseStore, loadStore, saveStore, type StorageAreaLike } from '../persistence/storage';
import { parseRequest, type Response } from './messages';

export interface Handler {
  handle(raw: unknown): Promise<Response>;
}

export function createHandler(area: StorageAreaLike, now: () => string = () => new Date().toISOString()): Handler {
  let queue: Promise<unknown> = Promise.resolve();

  async function process(raw: unknown): Promise<Response> {
    const request = parseRequest(raw);
    if (!request.ok) return { ok: false, error: { code: 'invalid_message', message: request.error } };

    if (request.value.kind === 'eraseAll') {
      try {
        await eraseStore(area);
        return { ok: true, outcome: 'applied', revision: 0 };
      } catch (err) {
        return { ok: false, error: { code: 'write_rejected', message: `Storage rejected the erase, so nothing was erased: ${describeError(err)}` } };
      }
    }

    const loaded = await loadStore(area);
    switch (loaded.status) {
      case 'storage_error':
        return { ok: false, error: { code: 'storage_error', message: `Saved data could not be read, so no change was attempted: ${loaded.error}` } };
      case 'corrupt':
        return { ok: false, error: { code: 'storage_unreadable', message: 'Stored data could not be read, so no change was attempted.' } };
      case 'unsupported_version':
        return { ok: false, error: { code: 'storage_unsupported', message: 'Stored data uses an unsupported version, so no change was attempted.' } };
      case 'ok':
        break;
    }

    if (request.value.kind === 'restore') {
      // Destination re-read and validated above, inside the serialised queue,
      // immediately before deciding: emptiness, staleness and receipt checks
      // here cannot be bypassed by a page.
      const req = request.value;
      const digest = await restorePayloadDigest(req.backup.exportedAt, req.backup.store);
      const decision = decideRestore(loaded.store, !loaded.isNew, req, digest, now());
      switch (decision.kind) {
        case 'refused':
          return { ok: false, error: { code: decision.code, message: decision.message } };
        case 'already_restored':
          return { ok: true, outcome: 'duplicate', revision: decision.revision };
        case 'empty_backup':
          return { ok: true, outcome: 'unchanged', revision: decision.revision };
        case 'write':
          break;
      }
      // Defence in depth: never write a ledger that would not read back as valid.
      const check = parseStore(JSON.parse(JSON.stringify(decision.store)));
      if (check.status !== 'ok') {
        return { ok: false, error: { code: 'not_applied', message: 'The restored data did not pass validation, so nothing was written.' } };
      }
      try {
        // One write: the restored cases and the receipt that identifies this operation.
        await saveStore(area, decision.store);
      } catch (err) {
        return { ok: false, error: { code: 'write_rejected', message: `Storage rejected the restore, so nothing was restored: ${describeError(err)}` } };
      }
      return { ok: true, outcome: 'applied', revision: decision.store.revision };
    }

    const result = applyCommand(loaded.store, request.value.command, now());
    if (!result.ok) return { ok: false, error: result.error };
    if (result.outcome !== 'applied') return { ok: true, outcome: result.outcome, revision: loaded.store.revision };
    try {
      await saveStore(area, result.store);
    } catch (err) {
      // chrome.storage.local.set rejected: the write was not committed.
      return { ok: false, error: { code: 'write_rejected', message: `Storage rejected the change, so it was not saved: ${describeError(err)}` } };
    }
    return { ok: true, outcome: 'applied', revision: result.store.revision };
  }

  return {
    handle(raw) {
      const run = queue.then(() => process(raw));
      queue = run.catch(() => undefined);
      // process() only throws before its write (e.g. an unsafe monetary sum), so nothing was written.
      return run.catch((err: unknown): Response => ({
        ok: false,
        error: { code: 'not_applied', message: `The change could not be applied, so nothing was written: ${describeError(err)}` },
      }));
    },
  };
}
