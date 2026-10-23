import { useTheme } from './ThemeContext';

export function ThemeSelect() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="grid max-w-sm gap-2">
      <label htmlFor="theme-preference" className="text-sm font-medium">
        Theme
      </label>
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => setPreference(event.target.value as 'system' | 'light' | 'dark')}
        className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent sm:text-sm"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <p className="text-sm text-ink-muted">System follows your device appearance.</p>
    </div>
  );
}
