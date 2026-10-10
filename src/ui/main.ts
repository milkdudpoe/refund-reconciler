import { startApp } from './app';
import { chromeDeps } from './deps';
import './styles.css';

const root = document.getElementById('app');
const status = document.getElementById('status');
// The toolbar popup links here with #create when no suitable case exists.
if (root && status) startApp(root, status, chromeDeps(), { startInCreate: location.hash === '#create' });
