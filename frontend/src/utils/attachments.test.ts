import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, type Attachment } from '@linka/shared';
import { testFile } from '../test/xhr';
import { ATTACHMENT_ACCEPT, attachmentSummary, checkFile, fileBadge, formatBytes, resolveContentType } from './attachments';

const attachment = (fileName: string, contentType: Attachment['contentType']): Attachment => ({
  id: crypto.randomUUID(),
  fileName,
  contentType,
  sizeBytes: 100,
});

describe('resolveContentType', () => {
  it('keeps the type the browser reported', () => {
    expect(resolveContentType({ name: 'photo.png', type: 'image/png' })).toBe('image/png');
    // A mismatch is kept so validation can reject it, not silently "fixed".
    expect(resolveContentType({ name: 'photo.exe', type: 'image/png' })).toBe('image/png');
  });

  it('falls back to the extension when the browser reports nothing', () => {
    expect(resolveContentType({ name: 'notes.TXT', type: '' })).toBe('text/plain');
    expect(resolveContentType({ name: 'report.docx', type: '' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(resolveContentType({ name: 'run.exe', type: '' })).toBe('');
  });
});

describe('checkFile', () => {
  it('accepts supported files within their limit', () => {
    expect(checkFile(testFile('beach.png', 'image/png'))).toEqual({ ok: true, fileName: 'beach.png', contentType: 'image/png', sizeBytes: 2048 });
  });

  it.each([
    ['an unsupported type', testFile('logo.svg', 'image/svg+xml'), 'This type of file is not supported.'],
    ['an HTML file', testFile('page.html', 'text/html'), 'This type of file is not supported.'],
    ['an empty file', testFile('empty.txt', 'text/plain', 0), 'This file is empty.'],
    ['an image over 10 MB', testFile('huge.jpg', 'image/jpeg', MAX_IMAGE_BYTES + 1), 'This file is too large (max 10 MB).'],
    ['a file over 25 MB', testFile('huge.pdf', 'application/pdf', MAX_FILE_BYTES + 1), 'This file is too large (max 25 MB).'],
    ['a wrong extension', testFile('virus.exe', 'image/png'), 'The file name must end in .png for this type of file.'],
  ])('rejects %s', (_label, file, message) => {
    expect(checkFile(file)).toEqual({ ok: false, error: message });
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
  });

  it('makes a short badge from the extension', () => {
    expect(fileBadge('plan.pdf')).toBe('PDF');
    expect(fileBadge('deck.pptx')).toBe('PPTX');
    expect(fileBadge('README')).toBe('FILE');
  });

  it('summarises attachments for the chat list', () => {
    expect(attachmentSummary([])).toBe('');
    expect(attachmentSummary([attachment('a.png', 'image/png')])).toBe('Photo');
    expect(attachmentSummary([attachment('a.png', 'image/png'), attachment('b.jpg', 'image/jpeg')])).toBe('2 photos');
    expect(attachmentSummary([attachment('plan.pdf', 'application/pdf')])).toBe('plan.pdf');
    expect(attachmentSummary([attachment('a.png', 'image/png'), attachment('plan.pdf', 'application/pdf')])).toBe('2 files');
  });

  it('offers only the allowed types in the file picker', () => {
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual(expect.arrayContaining(['image/png', '.png', 'application/pdf', '.docx']));
    expect(ATTACHMENT_ACCEPT).not.toMatch(/svg|html/);
  });
});
