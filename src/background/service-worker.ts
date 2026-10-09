import { chromeLocalArea } from '../persistence/storage';
import { createHandler } from './handler';

const handler = createHandler(chromeLocalArea());

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only accept messages from this extension's own pages.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ ok: false, error: { code: 'invalid_message', message: 'Unknown sender.' } });
    return false;
  }
  void handler.handle(message).then(sendResponse);
  return true;
});
