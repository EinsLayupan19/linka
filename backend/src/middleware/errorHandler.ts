import type { ErrorRequestHandler } from 'express';
import { ErrorCode, type ApiErrorResponse } from '@linka/shared';
import { AppError } from '../utils/AppError.js';
import { describeError } from '../utils/describeError.js';

// Errors thrown by express.json() carry a `type` field.
function isBodyParserError(error: unknown): error is { type: string } {
  return typeof error === 'object' && error !== null && 'type' in error;
}

function toPublicError(error: unknown): { statusCode: number; body: ApiErrorResponse } {
  if (error instanceof AppError) {
    const { code, message, fields } = error;
    return { statusCode: error.statusCode, body: { error: fields ? { code, message, fields } : { code, message } } };
  }

  if (isBodyParserError(error) && error.type === 'entity.parse.failed') {
    return { statusCode: 400, body: { error: { code: ErrorCode.BadRequest, message: 'Malformed JSON body' } } };
  }

  if (isBodyParserError(error) && error.type === 'entity.too.large') {
    return {
      statusCode: 413,
      body: { error: { code: ErrorCode.PayloadTooLarge, message: 'Request body is too large' } },
    };
  }

  // A compressed body (the API never decompresses, see app.ts) or an unknown character set:
  // the client's request, not a server failure.
  if (isBodyParserError(error) && error.type === 'encoding.unsupported') {
    return {
      statusCode: 415,
      body: { error: { code: ErrorCode.UnsupportedMediaType, message: 'Compressed request bodies are not accepted.' } },
    };
  }
  if (isBodyParserError(error) && error.type === 'charset.unsupported') {
    return {
      statusCode: 415,
      body: { error: { code: ErrorCode.UnsupportedMediaType, message: 'Unsupported character set.' } },
    };
  }

  return { statusCode: 500, body: { error: { code: ErrorCode.Internal, message: 'Something went wrong' } } };
}

// Express recognises error handlers by their four arguments.
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // If the response already started, it cannot be replaced; let Express close the connection.
  if (res.headersSent) {
    next(error);
    return;
  }

  const { statusCode, body } = toPublicError(error);

  if (statusCode >= 500) {
    // Details stay in the server logs, never in the response. Request bodies and query values
    // are never logged (see describeError).
    console.error(`Unhandled error on ${req.method} ${req.path}: ${describeError(error)}`);
  }

  res.status(statusCode).json(body);
};
