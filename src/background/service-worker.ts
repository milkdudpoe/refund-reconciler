import { chromeLocalArea } from '../persistence/storage';
import { createHandler } from './handler';

const handler = createHandler(chromeLocalArea());

// Ledger storage is for this extension's own pages and service worker only.
// The capture collector runs in pages and must never be able to read or write it.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((err: unknown) => {
  console.error('Could not restrict storage access level', err);
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
