import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './components/auth/AuthProvider';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { warmUpApi } from './lib/serverWake';
import './index.css';

// Wake the API now, while the page restores the session; the first real request then waits less.
void warmUpApi();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
