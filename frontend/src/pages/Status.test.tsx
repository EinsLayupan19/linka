import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../test/fetch';
import { Status } from './Status';

function row(label: string) {
  const item = screen.getByText(label).closest('li');
  if (!item) throw new Error(`No status row for ${label}`);
  return within(item);
}

describe('Status page', () => {
  it('shows a loading state while the check runs', () => {
    mockFetch().mockReturnValue(new Promise(() => {}));
    render(<Status />);

    expect(screen.getByRole('list', { name: 'Service status' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByText('Checking')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
  });

  it('shows API and database as healthy when the API reports ok', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ status: 'ok', database: 'connected' }));
    render(<Status />);

    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(row('Database').getByText('Connected')).toBeInTheDocument();
  });

  it('tells the developer how to configure a missing database', async () => {
    mockFetch().mockResolvedValue(jsonResponse({ status: 'degraded', database: 'not_configured' }));
    render(<Status />);

    expect(await screen.findByText('Set DATABASE_URL in backend/.env.')).toBeInTheDocument();
  });

  it('shows Supabase as not configured when no credentials are set', () => {
    mockFetch().mockReturnValue(new Promise(() => {}));
    render(<Status />);

    expect(row('Supabase client').getByText('Not configured')).toBeInTheDocument();
  });

  it('shows an error when the API is unreachable, and recovers on retry', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<Status />);

    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    expect(row('API server').getByText('Unreachable')).toBeInTheDocument();
    expect(row('Database').getByText('Unknown')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok', database: 'connected' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByText('Online')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
