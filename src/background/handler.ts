// Serialises every write through one queue so concurrent dashboard views can
// never overwrite each other's updates (each command is applied to the latest
// stored state, never to a stale copy held by a page).

import { applyCommand } from '../domain/ledger';
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
        return { ok: false, error: { code: 'save_failed', message: describeError(err) } };
      }
    }

    const loaded = await loadStore(area);
    switch (loaded.status) {
      case 'storage_error':
        return { ok: false, error: { code: 'storage_error', message: loaded.error } };
      case 'corrupt':
        return { ok: false, error: { code: 'storage_unreadable', message: 'Stored data could not be read, so nothing was changed.' } };
      case 'unsupported_version':
        return { ok: false, error: { code: 'storage_unsupported', message: 'Stored data uses an unsupported version, so nothing was changed.' } };
      case 'ok':
        break;
    }

    const result = applyCommand(loaded.store, request.value.command, now());
    if (!result.ok) return { ok: false, error: result.error };
    if (result.outcome !== 'applied') return { ok: true, outcome: result.outcome, revision: loaded.store.revision };
    try {
      await saveStore(area, result.store);
    } catch (err) {
      return { ok: false, error: { code: 'save_failed', message: `Not saved: ${describeError(err)}` } };
    }
    return { ok: true, outcome: 'applied', revision: result.store.revision };
  }

  return {
    handle(raw) {
      const run = queue.then(() => process(raw));
      queue = run.catch(() => undefined);
      return run.catch((err: unknown): Response => ({ ok: false, error: { code: 'storage_error', message: describeError(err) } }));
    },
  };
}
