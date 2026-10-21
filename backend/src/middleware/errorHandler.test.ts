import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';
import { errorHandler } from './errorHandler.js';

function appThatThrows(error: unknown) {
  const app = express();
  app.get('/boom', () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns AppError status, code and message', async () => {
    const res = await request(appThatThrows(new AppError(404, ErrorCode.NotFound, 'Conversation not found'))).get(
      '/boom',
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } });
  });

  it('hides the details of unexpected errors from the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThatThrows(new Error('password=hunter2 at db.internal:5432'))).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toContain('at ');
  });

  it('logs unexpected errors on the server', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(appThatThrows(new Error('kaboom'))).get('/boom');

    expect(log).toHaveBeenCalledOnce();
  });

  it('hands errors to Express when the response has already started', () => {
    const error = new Error('failed mid-response');
    const res = { headersSent: true, status: vi.fn(), json: vi.fn() };
    const next = vi.fn();

    errorHandler(error, {} as Request, res as unknown as Response, next);

    // Express's default handler then closes the connection; we must not write a second response.
    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('handles async errors (Express 5 forwards rejected promises)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = express();
    app.get('/boom', async () => {
      throw new Error('async failure');
    });
    app.use(errorHandler);

    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
  });
});
