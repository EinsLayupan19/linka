import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { realtimeChannels } from './supabaseMock';

// Pages are loaded on first use (code splitting). In tests, Vite compiles such a page the first
// time it is imported, which can take more than the default 1 s while every file runs at once.
// findBy* / waitFor wait longer for the same thing; nothing they check changes.
configure({ asyncUtilTimeout: 3000 });

// jsdom has <dialog> but not showModal() / close(). This stand-in only toggles `open` and fires
// `close` like browsers do; focus trapping and the backdrop are the browser's and not tested here.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

afterEach(() => {
  realtimeChannels.length = 0;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Puts every vi.fn() back to its original implementation (e.g. the Supabase mock defaults).
  vi.resetAllMocks();
});
