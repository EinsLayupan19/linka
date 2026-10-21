/** Where a signed-out user was going, so login can send them back. */
export interface RedirectState {
  from?: string;
}

/** Only same-site paths: "/profile" yes; "//evil.example" or "https://..." no. */
export function safeRedirectPath(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}
