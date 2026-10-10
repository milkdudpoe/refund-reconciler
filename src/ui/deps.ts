// Browser bindings shared by the dashboard and the toolbar popup. Pages read
// storage directly but send every change to the service worker.

import { isResponse, type Request, type Response } from '../background/messages';
import { STORE_KEY, type StorageAreaLike } from '../persistence/storage';

export interface AppDeps {
  area: StorageAreaLike;
  send: (req: Request) => Promise<Response>;
  newId: () => string;
  subscribe: (onChange: () => void) => void;
}

export function chromeDeps(): AppDeps {
  return {
    area: {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
      remove: (key) => chrome.storage.local.remove(key),
    },
    async send(req) {
      try {
        const res: unknown = await chrome.runtime.sendMessage(req);
        if (isResponse(res)) return res;
        return { ok: false, error: { code: 'outcome_unknown', message: 'The extension did not return a valid response.' } };
      } catch (err) {
        // The request may have reached the service worker and been saved before
        // the reply was lost, so this is an unknown outcome, not a failure.
        return { ok: false, error: { code: 'outcome_unknown', message: err instanceof Error ? err.message : String(err) } };
      }
    },
    newId: () => crypto.randomUUID(),
    subscribe(onChange) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && STORE_KEY in changes) onChange();
      });
    },
  };
}
