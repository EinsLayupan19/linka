import { createHash } from 'node:crypto';

/**
 * The Content-Security-Policy for the built app, added to index.html by `vite build` (see
 * vite.config.ts). Build-time only: this file uses Node and is never part of the browser bundle.
 *
 * What the app needs, and nothing more:
 * - scripts, styles, fonts, icons: its own files ('self'); the inline theme script in index.html
 *   by the hash of its exact content (computed from the final HTML, so it can never go stale)
 * - connect: its API, Supabase over HTTPS (auth, storage uploads) and Supabase Realtime (WebSocket)
 * - images: its own, upload previews (blob:) and Supabase Storage (avatars, attachments)
 * Not governed by CSP, so needing no entry: call audio/video (MediaStream srcObject), WebRTC itself,
 * styles set from script (CSSOM), and download links (navigation).
 *
 * A <meta> policy cannot set frame-ancestors; the X-Frame-Options: DENY header in vercel.json
 * already blocks framing.
 */
export interface CspSources {
  /** VITE_API_URL */
  apiUrl: string;
  /** VITE_SUPABASE_URL */
  supabaseUrl: string;
}

export function buildContentSecurityPolicy({ apiUrl, supabaseUrl, scriptHashes }: CspSources & { scriptHashes: string[] }): string {
  const api = new URL(apiUrl).origin;
  const supabase = new URL(supabaseUrl).origin;
  const realtime = supabase.replace(/^http/, 'ws'); // https -> wss, http (local) -> ws

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...scriptHashes]],
    ['img-src', ["'self'", 'blob:', supabase]],
    ['connect-src', ["'self'", api, supabase, realtime]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** 'sha256-…' for an inline script, as browsers compute it (over the exact text between the tags). */
function scriptHash(code: string): string {
  return `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
}

/** Inline <script> elements (no src attribute): their exact content. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]!);
}

/**
 * index.html with the policy as a <meta> tag right after <meta charset>, so it applies before any
 * script runs.
 */
export function addContentSecurityPolicy(html: string, sources: CspSources): string {
  const policy = buildContentSecurityPolicy({ ...sources, scriptHashes: inlineScripts(html).map(scriptHash) });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  const charset = /<meta charset="[^"]*"\s*\/?>/i.exec(html);
  if (!charset) throw new Error('index.html needs a <meta charset> before the Content-Security-Policy can be added');
  const at = charset.index + charset[0].length;
  return `${html.slice(0, at)}\n    ${meta}${html.slice(at)}`;
}
