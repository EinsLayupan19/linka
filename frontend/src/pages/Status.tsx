import { StatusRow, type StatusRowProps } from '../components/system/StatusRow';
import { Button } from '../components/ui/Button';
import { useHealth, type HealthState } from '../hooks/useHealth';
import { env } from '../lib/env';
import { isSupabaseConfigured } from '../lib/supabase';

function apiRow(state: HealthState): StatusRowProps {
  const label = 'API server';
  if (state.status === 'loading') return { label, loading: true };
  if (state.status === 'error') {
    return { label, tone: 'danger', value: 'Unreachable', detail: state.error.message };
  }
  return { label, tone: 'ok', value: 'Online', detail: `Responding at ${env.VITE_API_URL}` };
}

function databaseRow(state: HealthState): StatusRowProps {
  const label = 'Database';
  if (state.status === 'loading') return { label, loading: true };
  if (state.status === 'error') {
    return { label, tone: 'neutral', value: 'Unknown', detail: 'Waiting for the API server.' };
  }

  switch (state.data.database) {
    case 'connected':
      return { label, tone: 'ok', value: 'Connected', detail: 'PostgreSQL is reachable from the API.' };
    case 'not_configured':
      return { label, tone: 'warning', value: 'Not configured', detail: 'Set DATABASE_URL in backend/.env.' };
    case 'unreachable':
      return {
        label,
        tone: 'danger',
        value: 'Unreachable',
        detail: 'The API could not reach PostgreSQL. Check DATABASE_URL.',
      };
  }
}

function supabaseRow(): StatusRowProps {
  const label = 'Supabase client';
  return isSupabaseConfigured
    ? { label, tone: 'ok', value: 'Configured', detail: 'Project URL and publishable key are set.' }
    : {
        label,
        tone: 'warning',
        value: 'Not configured',
        detail: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in frontend/.env.',
      };
}

export function Status() {
  const { state, retry } = useHealth();
  const rows = [apiRow(state), databaseRow(state), supabaseRow()];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">System status</h1>
      <p className="mt-2 max-w-[60ch] text-ink-muted">
        Checks the connection from this browser to the Linka API and the services it depends on.
      </p>

      <ul
        aria-label="Service status"
        aria-busy={state.status === 'loading'}
        aria-live="polite"
        className="mt-8 divide-y divide-line rounded-xl border border-line bg-surface"
      >
        {rows.map((row) => (
          <StatusRow key={row.label} {...row} />
        ))}
      </ul>

      <div className="mt-6">
        <Button onClick={retry} disabled={state.status === 'loading'}>
          Check again
        </Button>
      </div>
    </div>
  );
}
