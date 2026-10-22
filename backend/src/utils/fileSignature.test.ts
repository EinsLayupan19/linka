import { describe, expect, it } from 'vitest';
import { ATTACHMENT_CONTENT_TYPES } from '@linka/shared';
import { matchesSignature } from './fileSignature.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => new TextEncoder().encode(text);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = ascii('GIF89a....');
const WEBP = ascii('RIFF\u0010\u0000\u0000\u0000WEBPVP8 ');
const PDF = ascii('%PDF-1.7\n');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0);
const EXE = bytes(0x4d, 0x5a, 0x90, 0x00);
const HTML = ascii('<!doctype html><script>alert(1)</script>');

describe('matchesSignature', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/gif', ascii('GIF87a')],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
    ['application/zip', ZIP],
    ['application/zip', bytes(0x50, 0x4b, 0x05, 0x06)],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
    ['text/plain', ascii('Hello\nworld')],
  ])('accepts a real %s', (type, head) => {
    expect(matchesSignature(head, type)).toBe(true);
  });

  it.each([
    ['an executable as PNG', EXE, 'image/png'],
    ['a JPEG as PNG', JPEG, 'image/png'],
    ['HTML as PNG', HTML, 'image/png'],
    ['a truncated PNG header', PNG.slice(0, 7), 'image/png'],
    ['RIFF that is not WebP (e.g. WAV)', ascii('RIFF\u0010\u0000\u0000\u0000WAVEfmt '), 'image/webp'],
    ['HTML as PDF', HTML, 'application/pdf'],
    ['an empty ZIP as a Word document', bytes(0x50, 0x4b, 0x05, 0x06), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['binary data as text', bytes(0x41, 0x00, 0x42), 'text/plain'],
    ['an empty text file', new Uint8Array(), 'text/plain'],
    ['a PNG disguised as text', PNG.map((b) => (b === 0 ? 0x20 : b)), 'text/plain'],
    ['a PDF disguised as text', PDF, 'text/plain'],
    ['a type that is not allowed', HTML, 'text/html'],
    ['SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'],
  ])('rejects %s', (_label, head, type) => {
    expect(matchesSignature(head, type)).toBe(false);
  });

  it('has a check for every allowed attachment type', () => {
    // An allowed type without a signature check would reject every file of that type, so this
    // catches a type added to the allowlist without a check.
    const samples: Record<string, Uint8Array> = { 'image/png': PNG, 'image/jpeg': JPEG, 'image/gif': GIF, 'image/webp': WEBP, 'application/pdf': PDF, 'text/plain': ascii('x') };
    for (const type of ATTACHMENT_CONTENT_TYPES) {
      expect(matchesSignature(samples[type] ?? ZIP, type), type).toBe(true);
    }
  });
});
