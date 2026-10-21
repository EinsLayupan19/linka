import { healthResponseSchema, type HealthResponse } from '@linka/shared';
import { apiRequest } from '../lib/api';

export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiRequest('/api/health', healthResponseSchema, { signal: signal ?? null });
}
