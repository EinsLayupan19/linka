import { vi } from 'vitest';

/**
 * A stand-in for XMLHttpRequest (used for direct-to-Storage uploads, since fetch cannot report
 * upload progress). Tests drive each request: report progress, then succeed, fail or abort.
 */
export class FakeXhr {
  static instances: FakeXhr[] = [];

  method = '';
  url = '';
  headers = new Map<string, string>();
  body: unknown = undefined;
  status = 0;
  aborted = false;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  // --- test controls ---
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status = 200) {
    this.status = status;
    this.onload?.();
  }
  failNetwork() {
    this.onerror?.();
  }
}

/** Installs FakeXhr and object-URL stubs (jsdom has neither) for the current test. */
export function installUploadFakes() {
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:preview-${++n}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (url: string) => revoked.push(url) });
  return { created, revoked, latest: () => FakeXhr.instances.at(-1) };
}

/** A File with real leading bytes (sizes matter: the API checks them). */
export function testFile(name: string, type: string, size = 2048): File {
  return new File([new Uint8Array(size).fill(0x41)], name, { type });
}
