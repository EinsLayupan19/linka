import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addContentSecurityPolicy, buildContentSecurityPolicy } from './contentSecurityPolicy';

/**
 * The Content-Security-Policy added to the built index.html: only Linka's own files may run, and
 * the app may only talk to its API and its Supabase project. Built from the same VITE_ addresses
 * the app uses, with the inline theme script allowed by its exact hash (never 'unsafe-inline').
 */
const sources = {
  apiUrl: 'https://linka-api.example.com',
  supabaseUrl: 'https://abcdefghijklmnop.supabase.co',
};

/** The policy's directives, by name. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values] as const;
      }),
  );
}

const sha256 = (code: string) => `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;

describe('buildContentSecurityPolicy', () => {
  const policy = directives(buildContentSecurityPolicy({ ...sources, scriptHashes: ["'sha256-abc='"] }));

  it('allows only same-origin code, plus the listed inline scripts by hash', () => {
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('script-src')).toEqual(["'self'", "'sha256-abc='"]);
  });

  it('never allows inline code or eval wholesale', () => {
    const all = [...policy.values()].flat();
    expect(all).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("'unsafe-eval'");
    expect(all).not.toContain('*');
  });

  it('lets the app reach its API, Supabase over HTTPS and Supabase Realtime over secure WebSockets', () => {
    expect(policy.get('connect-src')).toEqual([
      "'self'",
      'https://linka-api.example.com',
      'https://abcdefghijklmnop.supabase.co',
      'wss://abcdefghijklmnop.supabase.co',
    ]);
  });

  it('loads images from the app, upload previews (blob:) and Supabase Storage only', () => {
    expect(policy.get('img-src')).toEqual(["'self'", 'blob:', 'https://abcdefghijklmnop.supabase.co']);
  });

  it('blocks plugins, <base> hijacking and form posts elsewhere', () => {
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
  });

  it('uses origins only, whatever the configured URLs look like', () => {
    const local = directives(
      buildContentSecurityPolicy({ apiUrl: 'http://localhost:3000/', supabaseUrl: 'http://127.0.0.1:54321', scriptHashes: [] }),
    );
    expect(local.get('connect-src')).toEqual(["'self'", 'http://localhost:3000', 'http://127.0.0.1:54321', 'ws://127.0.0.1:54321']);
  });
});

describe('addContentSecurityPolicy', () => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Linka</title>
    <script>
      document.documentElement.dataset.theme = 'dark';
    </script>
    <script type="module" crossorigin src="/assets/index.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

  it('adds the policy right after the charset, before any script', () => {
    const out = addContentSecurityPolicy(html, sources);
    const meta = out.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(out.indexOf('<meta charset="UTF-8" />'));
    expect(meta).toBeLessThan(out.indexOf('<script'));
  });

  it('allows each inline script by the hash of its exact content, and no external script needs one', () => {
    const out = addContentSecurityPolicy(html, sources);
    const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(out)![1]!;
    const inline = "\n      document.documentElement.dataset.theme = 'dark';\n    ";
    expect(directives(content).get('script-src')).toEqual(["'self'", sha256(inline)]);
  });

  it('follows edits to the inline script (the hash can never go stale)', () => {
    const edited = html.replace("'dark'", "'light'");
    const editedInline = "\n      document.documentElement.dataset.theme = 'light';\n    ";
    expect(addContentSecurityPolicy(edited, sources)).toContain(sha256(editedInline));
    expect(addContentSecurityPolicy(edited, sources)).not.toContain(sha256(editedInline.replace('light', 'dark')));
  });

  it("covers Linka's real index.html theme script", () => {
    const frontendDir = existsSync(resolve(process.cwd(), 'index.html')) ? process.cwd() : resolve(process.cwd(), 'frontend');
    const real = readFileSync(resolve(frontendDir, 'index.html'), 'utf8');
    const inline = /<script>([\s\S]*?)<\/script>/.exec(real)![1]!;

    const out = addContentSecurityPolicy(real, sources);

    expect(out).toContain(sha256(inline));
  });
});
