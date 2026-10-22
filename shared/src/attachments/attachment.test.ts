import { describe, expect, it } from 'vitest';
import { createMessageSchema } from '../messages/message.js';
import {
  attachmentFileSchema,
  attachmentUrlsRequestSchema,
  createAttachmentUploadSchema,
  fileExtension,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from './attachment.js';

const clientId = '9b2d4f6a-8c0e-4a1b-9d3f-5e7a9c1b3d5f';
const file = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'beach.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 1234,
  ...overrides,
});
const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) => result.error?.issues[0]?.message;

describe('attachmentFileSchema', () => {
  it('accepts allowed types with a matching extension', () => {
    expect(attachmentFileSchema.safeParse(file()).success).toBe(true);
    expect(attachmentFileSchema.safeParse(file({ fileName: 'Report.PDF', contentType: 'application/pdf' })).success).toBe(true);
  });

  it.each(['image/svg+xml', 'text/html', 'application/x-msdownload', 'application/octet-stream', ''])(
    'rejects the type %j',
    (contentType) => {
      expect(firstMessage(attachmentFileSchema.safeParse(file({ contentType })))).toBe('This type of file is not supported.');
    },
  );

  it('rejects an extension that does not match the type', () => {
    expect(firstMessage(attachmentFileSchema.safeParse(file({ fileName: 'beach.png' })))).toMatch(/must end in \.jpg or \.jpeg/);
    expect(attachmentFileSchema.safeParse(file({ fileName: 'invoice.pdf.exe', contentType: 'application/pdf' })).success).toBe(false);
    expect(attachmentFileSchema.safeParse(file({ fileName: 'noextension' })).success).toBe(false);
  });

  it('rejects empty and oversized files, per kind', () => {
    expect(firstMessage(attachmentFileSchema.safeParse(file({ sizeBytes: 0 })))).toBe('This file is empty.');
    expect(attachmentFileSchema.safeParse(file({ sizeBytes: MAX_IMAGE_BYTES })).success).toBe(true);
    expect(attachmentFileSchema.safeParse(file({ sizeBytes: MAX_IMAGE_BYTES + 1 })).success).toBe(false);
    const pdf = { fileName: 'big.pdf', contentType: 'application/pdf' };
    expect(attachmentFileSchema.safeParse(file({ ...pdf, sizeBytes: MAX_FILE_BYTES })).success).toBe(true);
    expect(attachmentFileSchema.safeParse(file({ ...pdf, sizeBytes: MAX_FILE_BYTES + 1 })).success).toBe(false);
  });

  it.each([
    ['../../etc/passwd.txt', 'path separators'],
    ['..\\secret.txt', 'backslashes'],
    ['notes\u0000.txt', 'NUL'],
    ['line\nbreak.txt', 'newlines'],
    [' padded.txt', 'leading spaces'],
    ['invoice\u202etxt.txt', 'a right-to-left override (spoofs the shown extension)'],
    ['report\u2066x\u2069.txt', 'bidi isolates'],
    ['zero\u200bwidth.txt', 'invisible characters'],
    ['a'.repeat(252) + '.txt', 'over 255 characters'],
  ])('rejects the file name %j (%s)', (fileName) => {
    expect(attachmentFileSchema.safeParse(file({ fileName, contentType: 'text/plain' })).success).toBe(false);
  });

  it('allows ordinary names with dots and spaces', () => {
    expect(attachmentFileSchema.safeParse(file({ fileName: 'notes v2..final copy.txt', contentType: 'text/plain' })).success).toBe(true);
  });
});

describe('createAttachmentUploadSchema', () => {
  it('requires a client id and rejects unknown fields like a storage path', () => {
    expect(createAttachmentUploadSchema.safeParse({ ...file(), clientId }).success).toBe(true);
    expect(createAttachmentUploadSchema.safeParse(file()).success).toBe(false);
    expect(createAttachmentUploadSchema.safeParse({ ...file(), clientId, storagePath: 'x/y.jpg' }).success).toBe(false);
    expect(createAttachmentUploadSchema.safeParse({ ...file(), clientId, uploaderId: clientId }).success).toBe(false);
  });
});

describe('createMessageSchema with attachments', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('allows attachments without text, and text without attachments', () => {
    expect(createMessageSchema.safeParse({ clientId, attachmentIds: [id(1)] }).success).toBe(true);
    expect(createMessageSchema.safeParse({ clientId, content: 'hi' }).success).toBe(true);
  });

  it('requires one of them', () => {
    expect(firstMessage(createMessageSchema.safeParse({ clientId }))).toBe('Write a message or attach a file.');
    expect(createMessageSchema.safeParse({ clientId, attachmentIds: [] }).success).toBe(false);
  });

  it('caps attachments at 10 and rejects duplicates', () => {
    expect(createMessageSchema.safeParse({ clientId, attachmentIds: Array.from({ length: 11 }, (_, i) => id(i)) }).success).toBe(false);
    expect(createMessageSchema.safeParse({ clientId, attachmentIds: [id(1), id(1)] }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('extracts lowercase extensions', () => {
    expect(fileExtension('Photo.JPEG')).toBe('jpeg');
    expect(fileExtension('.hidden')).toBe('');
    expect(fileExtension('none')).toBe('');
  });

  it('caps URL requests at 50 ids', () => {
    expect(attachmentUrlsRequestSchema.safeParse({ attachmentIds: Array(51).fill(clientId) }).success).toBe(false);
  });
});
