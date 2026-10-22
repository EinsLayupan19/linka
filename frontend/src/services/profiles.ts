import { profileSchema, type CreateProfileInput, type Profile, type UpdateProfileInput } from '@linka/shared';
import { apiRequest } from '../lib/api';

export function getMyProfile(signal?: AbortSignal): Promise<Profile> {
  return apiRequest('/api/users/me', profileSchema, { auth: true, signal: signal ?? null });
}

export function createMyProfile(input: CreateProfileInput): Promise<Profile> {
  return apiRequest('/api/users/me', profileSchema, { auth: true, method: 'POST', json: input });
}

export function updateMyProfile(input: UpdateProfileInput): Promise<Profile> {
  return apiRequest('/api/users/me', profileSchema, { auth: true, method: 'PATCH', json: input });
}

/** Replaces the profile picture. The API checks type, size and real content before storing it. */
export function uploadMyAvatar(file: Blob, contentType: string): Promise<Profile> {
  return apiRequest('/api/users/me/avatar', profileSchema, { auth: true, method: 'PUT', file: { body: file, contentType } });
}

export function removeMyAvatar(): Promise<Profile> {
  return apiRequest('/api/users/me/avatar', profileSchema, { auth: true, method: 'DELETE' });
}
