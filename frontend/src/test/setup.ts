import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Puts every vi.fn() back to its original implementation (e.g. the Supabase mock defaults).
  vi.resetAllMocks();
});
