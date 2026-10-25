import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@signet/visualiser/tokens.css';
import '@signet/visualiser/interactive/details.css';
import '@signet/visualiser/interactive/keyboard.css';
import '@signet/visualiser/interactive/viewport.css';
import './styles.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
