import { chromeLocalArea, chromeSessionArea } from '../persistence/storage';
import { VAULT_CHANNEL } from '../vault/channel';
import { createHandler } from './handler';

/**
 * Ledger storage is for this extension's own pages and service worker only:
 * the injected capture collector runs in web pages and must never be able to
 * read either area. Both restrictions must be in place before any request is
 * handled; if either fails, every request is refused (see handler.ts) rather
 * than keeping a key or records somewhere less protected. A failure is retried
 * on the next request.
 */
let access: Promise<void> | null = null;
function ensureAccess(): Promise<void> {
  access ??= Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]).then(
    () => undefined,
    (err: unknown) => {
      access = null;
      throw err;
    },
  );
  return access;
}
void ensureAccess().catch((err: unknown) => {
  console.error('Could not restrict storage access level', err);
});

// Same-origin only: reaches this extension's own open pages, never web pages or content scripts. Carries no data.
const channel = new BroadcastChannel(VAULT_CHANNEL);

const handler = createHandler({
  local: chromeLocalArea(),
  session: chromeSessionArea(),
  ensureAccess,
  broadcast: () => channel.postMessage({ type: 'vault-changed' }),
});

// The toolbar button opens popup.html (manifest "default_popup"), which offers
// Capture and Open dashboard. Clicking it grants temporary activeTab access.

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ ok: false, error: { code: 'invalid_message', message: 'Unknown sender.' } });
    return false;
  }
  void handler.handle(message).then(sendResponse);
  return true;
});
