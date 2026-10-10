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

/** Dashboard-only browser bindings for exports. Neither reads nor writes the ledger. */
export interface DashboardDeps extends AppDeps {
  /** Resolves only once the clipboard write has completed; rejects if it was refused. */
  copyText: (text: string) => Promise<void>;
  /** Asks the browser to download `text` as a file. Only initiates the download. */
  requestDownload: (text: string, mimeType: string, filename: string) => void;
}

/** How long an object URL stays valid after a download is requested. */
const OBJECT_URL_LIFETIME_MS = 60_000;

function requestBlobDownload(text: string, mimeType: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  // The browser reads the blob asynchronously after the click; release it later.
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
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

export function dashboardDeps(): DashboardDeps {
  return {
    ...chromeDeps(),
    copyText: (text) => navigator.clipboard.writeText(text),
    requestDownload: requestBlobDownload,
  };
}
