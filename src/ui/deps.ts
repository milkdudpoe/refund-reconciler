// Browser bindings shared by the dashboard and the toolbar popup. Pages never
// touch chrome.storage directly and never hold a key: every read and every
// change goes to the service worker, and every reply is validated here.

import {
  isConsentResponse,
  isResponse,
  isVaultResponse,
  parseLegacyReadResponse,
  parseReadResponse,
  type ConsentResponse,
  type LegacyReadResponse,
  type Request,
  type Response,
  type VaultRequest,
  type VaultResponse,
} from '../background/messages';
import { LOCAL_KEYS } from '../persistence/storage';
import { VAULT_CHANNEL } from '../vault/channel';
import type { LedgerState } from '../vault/state';

export interface AppDeps {
  /** The current ledger state from the service worker. Never throws: a failed read is `storage_error`. */
  read: () => Promise<LedgerState>;
  send: (req: Request) => Promise<Response>;
  /** Setup, migration, unlock, Lock and erase. A lost reply is `outcome_unknown`. */
  vault: (req: Exclude<VaultRequest, { kind: 'read' } | { kind: 'readLegacy' }>) => Promise<VaultResponse>;
  /** The plaintext records of an earlier version, for the explicit pre-migration backup only. */
  readLegacy: () => Promise<LegacyReadResponse>;
  newId: () => string;
  /** Calls back when stored records or the vault state may have changed. */
  subscribe: (onChange: () => void) => void;
}

/** Dashboard-only browser bindings: agreement to the data practices, and exports (which neither read nor write the ledger). */
export interface DashboardDeps extends AppDeps {
  /** Agreement to the displayed data practices. A lost reply is `outcome_unknown`: re-read the state to find out. */
  acceptDataPractices: (version: number) => Promise<ConsentResponse>;
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function chromeDeps(): AppDeps {
  return {
    async read() {
      try {
        const raw: unknown = await chrome.runtime.sendMessage({ kind: 'read' });
        const res = parseReadResponse(raw);
        if (!res) {
          const claimedOk = typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === true;
          return { status: 'storage_error', error: claimedOk ? 'The extension returned saved data that failed validation, so it was not used.' : 'The extension did not return a valid reply.' };
        }
        return res.ok ? res.ledger : { status: 'storage_error', error: res.error.message };
      } catch (err) {
        return { status: 'storage_error', error: describe(err) };
      }
    },
    async readLegacy() {
      try {
        const res = parseLegacyReadResponse(await chrome.runtime.sendMessage({ kind: 'readLegacy' }));
        return res ?? { ok: false, error: { code: 'invalid_reply', message: 'The extension did not return a valid reply.' } };
      } catch (err) {
        return { ok: false, error: { code: 'read_failed', message: describe(err) } };
      }
    },
    async vault(req) {
      try {
        const res: unknown = await chrome.runtime.sendMessage(req);
        if (isVaultResponse(res)) return res;
        return { ok: false, error: { code: 'outcome_unknown', message: 'The extension did not return a valid response.' } };
      } catch (err) {
        // It may have been carried out before the reply was lost: re-read the state.
        return { ok: false, error: { code: 'outcome_unknown', message: describe(err) } };
      }
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
      // Local area only: this page never listens to chrome.storage.session, which holds the unlocked key.
      chrome.storage.local.onChanged.addListener((changes) => {
        if (LOCAL_KEYS.some((k) => k in changes)) onChange();
      });
      // Lock, unlock and erase may change no local key; the worker announces them (no data) on this channel.
      // Changes to the consent receipt (agreement, erase, or damage) arrive through the local-area listener above.
      const channel = new BroadcastChannel(VAULT_CHANNEL);
      channel.onmessage = (ev: MessageEvent) => {
        if ((ev.data as { type?: unknown } | null)?.type === 'vault-changed') onChange();
      };
    },
  };
}

export function dashboardDeps(): DashboardDeps {
  return {
    ...chromeDeps(),
    async acceptDataPractices(version) {
      try {
        const res: unknown = await chrome.runtime.sendMessage({ kind: 'acceptDataPractices', version });
        if (isConsentResponse(res)) return res;
        return { ok: false, error: { code: 'outcome_unknown', message: 'The extension did not return a valid response.' } };
      } catch (err) {
        // It may have been stored before the reply was lost: re-read the state.
        return { ok: false, error: { code: 'outcome_unknown', message: describe(err) } };
      }
    },
    copyText: (text) => navigator.clipboard.writeText(text),
    requestDownload: requestBlobDownload,
  };
}
