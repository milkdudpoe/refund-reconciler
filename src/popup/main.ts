import { chromeAcquireDeps } from '../capture/acquire';
import { chromeDeps } from '../ui/deps';
import '../ui/styles.css';
import { startPopup } from './popup';

const root = document.getElementById('app');
const status = document.getElementById('status');
if (root && status) {
  startPopup(root, status, {
    ...chromeDeps(),
    acquire: chromeAcquireDeps(),
    async sourceTab() {
      // The tab the toolbar button was clicked on. Its URL is only visible
      // because the click granted temporary activeTab access.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { id: tab?.id ?? null, url: tab?.url };
    },
    openDashboard(hash) {
      void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
      window.close();
    },
    now: () => new Date().toISOString(),
  });
}
