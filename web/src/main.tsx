import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { clearStaleLayer } from './readerNavigation';
import GlassEffects from './GlassEffects';
import UpdatePrompt from './UpdatePrompt';
import { startAppUpdates } from './appUpdates';
import './reader-theme.css';
import './styles.css';
import './glass.css';
import './collections.css';
clearStaleLayer();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <GlassEffects />
    <UpdatePrompt />
  </React.StrictMode>,
);
if (import.meta.env.PROD) {
  if (document.readyState === 'complete') startAppUpdates();
  else window.addEventListener('load', startAppUpdates, { once: true });
}
