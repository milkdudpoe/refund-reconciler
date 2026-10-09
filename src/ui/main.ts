import { chromeDeps, startApp } from './app';
import './styles.css';

const root = document.getElementById('app');
const status = document.getElementById('status');
if (root && status) startApp(root, status, chromeDeps());
