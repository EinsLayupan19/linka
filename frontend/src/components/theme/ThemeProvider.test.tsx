import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSelect } from './ThemeSelect';
import { ThemeProvider } from './ThemeProvider';

function ThemeSettings() {
  return (
    <ThemeProvider>
      <ThemeSelect />
    </ThemeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
});

describe('theme preference', () => {
  it('switches themes and restores the saved choice after remounting', () => {
    const view = render(<ThemeSettings />);
    const select = screen.getByRole('combobox', { name: 'Theme' });

    expect(select).toHaveValue('system');
    fireEvent.change(select, { target: { value: 'dark' } });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(window.localStorage.getItem('linka-theme')).toBe('dark');

    view.unmount();
    render(<ThemeSettings />);

    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('follows OS changes while System is selected', () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const media = {
      matches: false,
      addEventListener: (_: string, listener: EventListenerOrEventListenerObject) => {
        listeners.push(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => media));

    render(<ThemeSettings />);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    act(() => {
      media.matches = true;
      for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
    });

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });
});
