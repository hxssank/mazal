import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/styles.css';
import App from './app/App.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
);
