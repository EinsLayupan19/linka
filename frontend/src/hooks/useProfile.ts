import { createContext, useContext } from 'react';
import type { Profile } from '@linka/shared';

export interface ProfileContextValue {
  profile: Profile;
  /** Replace the cached profile after a successful update. */
  setProfile: (profile: Profile) => void;
}

export const ProfileContext = createContext<ProfileContextValue | null>(null);

/** The signed-in user's profile. Only available inside <RequireProfile>. */
export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('useProfile must be used inside <RequireProfile>');
  return value;
}

/** Like useProfile, but returns null outside <RequireProfile> (e.g. public pages). */
export function useOptionalProfile(): ProfileContextValue | null {
  return useContext(ProfileContext);
}
