/**
 * Checks a file's first bytes against the type it claims to be. The client-provided MIME type
 * (and the Content-Type stored with the upload) are only claims; these signatures are what the
 * bytes actually are. Office documents are ZIP containers, so they are checked as ZIP.
 */

/** How many leading bytes the checks need (text needs the most). */
export const SIGNATURE_BYTES = 512;

const startsWith = (head: Uint8Array, bytes: number[], offset = 0) =>
  head.byteLength >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_ARCHIVE = [0x50, 0x4b, 0x05, 0x06];

const SIGNATURES: Record<string, (head: Uint8Array) => boolean> = {
  'image/jpeg': (head) => startsWith(head, [0xff, 0xd8, 0xff]),
  'image/png': (head) => startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/gif': (head) => startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a')),
  'image/webp': (head) => startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8),
  'application/pdf': (head) => startsWith(head, ascii('%PDF-')),
  'application/zip': (head) => startsWith(head, ZIP_LOCAL_HEADER) || startsWith(head, ZIP_EMPTY_ARCHIVE),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (head) => startsWith(head, ZIP_LOCAL_HEADER),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (head) => startsWith(head, ZIP_LOCAL_HEADER),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (head) => startsWith(head, ZIP_LOCAL_HEADER),
  // Plain text has no signature: it must not contain NUL bytes (binary files almost always do)
  // and must not be one of the binary formats above in disguise.
  'text/plain': (head) =>
    head.byteLength > 0 &&
    !head.includes(0) &&
    !Object.entries(SIGNATURES).some(([type, check]) => type !== 'text/plain' && check(head)),
};

export function matchesSignature(head: Uint8Array, contentType: string): boolean {
  const check = SIGNATURES[contentType];
  return check ? check(head) : false;
}
