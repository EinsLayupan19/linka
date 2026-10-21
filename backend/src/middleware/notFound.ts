import type { RequestHandler } from 'express';
import { ErrorCode } from '@linka/shared';
import { AppError } from '../utils/AppError.js';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, ErrorCode.NotFound, 'Route not found'));
};
