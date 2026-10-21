import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { apiErrorResponseSchema, healthResponseSchema, type DatabaseStatus } from '@linka/shared';
import { createApp } from './app.js';

function appWithDatabase(status: DatabaseStatus) {
  return createApp({ checkDatabase: async () => status });
}

describe('GET /api/health', () => {
  it('reports ok when the database is connected', async () => {
    const res = await request(appWithDatabase('connected')).get('/api/health');

    expect(res.status).toBe(200);
    expect(healthResponseSchema.parse(res.body)).toEqual({ status: 'ok', database: 'connected' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['unreachable', 'not_configured'] as const)(
    'reports degraded (still 200) when the database is %s',
    async (database) => {
      const res = await request(appWithDatabase(database)).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'degraded', database });
    },
  );

  it('reports not_configured with the real check when DATABASE_URL is unset', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.body).toEqual({ status: 'degraded', database: 'not_configured' });
  });
});

describe('unknown routes', () => {
  it('return a JSON 404 in the shared error shape', async () => {
    const res = await request(appWithDatabase('connected')).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(apiErrorResponseSchema.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});

describe('request bodies', () => {
  it('rejects malformed JSON with a 400', async () => {
    const res = await request(appWithDatabase('connected'))
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects bodies over the size limit with a 413', async () => {
    const res = await request(appWithDatabase('connected'))
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('security headers and CORS', () => {
  it('sets helmet headers and hides the Express fingerprint', async () => {
    const res = await request(appWithDatabase('connected')).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured frontend origin', async () => {
    const res = await request(appWithDatabase('connected'))
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow other origins', async () => {
    const res = await request(appWithDatabase('connected'))
      .get('/api/health')
      .set('Origin', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
