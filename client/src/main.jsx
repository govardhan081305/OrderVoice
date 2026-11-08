import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerServiceWorker } from './lib/push';

// Background service worker: rings the phone for incoming calls when the app is closed.
registerServiceWorker();

// Dev helper: open the app with ?relay=1 to force calls through the TURN relay
// (to demo/measure relay calls), ?relay=0 to go back to normal.
const relay = new URLSearchParams(window.location.search).get('relay');
if (relay !== null) { try { localStorage.setItem('ov.forceRelay', relay === '1' ? '1' : '0'); } catch { /* ignore */ } }

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);