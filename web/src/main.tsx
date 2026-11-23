import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import GlassEffects from './GlassEffects';
import './reader-theme.css';
import './styles.css';
import './glass.css';
import './collections.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <GlassEffects />
  </React.StrictMode>,
);
if ('serviceWorker' in navigator && import.meta.env.PROD)
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
