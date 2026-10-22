import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../test/api';
import { jsonResponse } from '../test/fetch';
import { createDeliveryReporter } from './receipts';

vi.mock('../lib/supabase', async () => (await import('../test/supabaseMock')).supabaseModule);

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, seconds)).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function deliveredApi() {
  return mockApi((call) => (call.path === '/api/conversations/delivered' ? jsonResponse({ updated: [] }) : undefined));
}

/** Lets the reporter's flush (timer + awaited requests) run to completion. */
async function settle(ms = 1500) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('delivery reporter', () => {
  it('coalesces many received messages into one request with the newest time per conversation', async () => {
    const api = deliveredApi();
    const reporter = createDeliveryReporter();

    reporter.report(id(1), at(1));
    reporter.report(id(1), at(3));
    reporter.report(id(1), at(2));
    reporter.report(id(2), at(5));
    await settle();

    const calls = api.callsTo('POST', '/api/conversations/delivered');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      conversations: [
        { conversationId: id(1), lastDeliveredAt: at(3) },
        { conversationId: id(2), lastDeliveredAt: at(5) },
      ],
    });
  });

  it('never sends a time the server already has', async () => {
    const api = deliveredApi();
    const reporter = createDeliveryReporter();
    reporter.seed(id(1), at(10));

    reporter.report(id(1), at(5));
    reporter.report(id(1), at(10));
    await settle();
    expect(api.calls).toHaveLength(0);

    reporter.report(id(1), at(11));
    await settle();
    reporter.report(id(1), at(11)); // already acknowledged
    await settle();
    expect(api.callsTo('POST', '/api/conversations/delivered')).toHaveLength(1);
  });

  it('splits large batches into requests of at most 50', async () => {
    const api = deliveredApi();
    const reporter = createDeliveryReporter();
    for (let n = 1; n <= 60; n++) reporter.report(id(n), at(1));
    await settle();

    const sizes = api.callsTo('POST', '/api/conversations/delivered').map((c) => (c.body as { conversations: unknown[] }).conversations.length);
    expect(sizes).toEqual([50, 10]);
  });

  it('survives a failed request and reports again on the next message', async () => {
    let fail = true;
    const api = mockApi(() => (fail ? Promise.reject(new TypeError('offline')) : jsonResponse({ updated: [] })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reporter = createDeliveryReporter();

    reporter.report(id(1), at(1));
    await settle();
    fail = false;
    reporter.report(id(1), at(2));
    await settle();

    expect(api.calls).toHaveLength(2);
    expect((api.calls[1]!.body as { conversations: unknown[] }).conversations).toEqual([{ conversationId: id(1), lastDeliveredAt: at(2) }]);
  });

  it('flushes what is pending when disposed, then stops', async () => {
    const api = deliveredApi();
    const reporter = createDeliveryReporter();
    reporter.report(id(1), at(1));
    reporter.dispose();
    await settle(0);
    reporter.report(id(2), at(2));
    await settle();

    expect(api.calls).toHaveLength(1);
  });
});
