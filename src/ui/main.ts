import { startApp } from './app';
import { dashboardDeps } from './deps';
import { buildHelp } from './help';
import { buildPrivacy } from './practices';
import './styles.css';

const root = document.getElementById('app');
const status = document.getElementById('status');
// The guide lives in the static header, outside the app's render tree, so
// re-renders never close it and using it never changes app state.
const help = buildHelp();
// "Data and privacy": the data-practices text, to reread at any time. Static, like the guide.
document.querySelector('.site-header')?.append(buildPrivacy(), help);
// The toolbar popup links here with #create when no suitable case exists, and
// with #help from its "How to use" button.
if (root && status) startApp(root, status, dashboardDeps(), { startInCreate: location.hash === '#create' });
if (location.hash === '#help') {
  help.open = true;
  help.querySelector('summary')?.focus();
}
