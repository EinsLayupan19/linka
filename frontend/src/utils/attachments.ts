import {
  ALLOWED_ATTACHMENT_TYPES,
  attachmentFileSchema,
  AVATAR_CONTENT_TYPES,
  MAX_AVATAR_BYTES,
  attachmentKind,
  fileExtension,
  type Attachment,
  type AttachmentContentType,
} from '@linka/shared';

/** The accept attribute for the file picker: every allowed type and extension. */
export const ATTACHMENT_ACCEPT = Object.entries(ALLOWED_ATTACHMENT_TYPES)
  .flatMap(([type, { extensions }]) => [type, ...extensions.map((ext) => `.${ext}`)])
  .join(',');

/**
 * The type to upload a file as. Browsers leave `file.type` empty for some files (often .docx or
 * .txt on some systems), so an empty type falls back to the extension. A type the browser did
 * report is kept as is, so a mismatching extension is caught by validation, not papered over.
 * (The server checks the real content either way; this is only for early, friendly errors.)
 */
export function resolveContentType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = fileExtension(file.name);
  const match = Object.entries(ALLOWED_ATTACHMENT_TYPES).find(([, { extensions }]) =>
    (extensions as readonly string[]).includes(ext),
  );
  return match?.[0] ?? '';
}

export type FileCheck =
  | { ok: true; fileName: string; contentType: AttachmentContentType; sizeBytes: number }
  | { ok: false; error: string };

/** The same checks the server applies before an upload starts (name, type, extension, size). */
export function checkFile(file: File): FileCheck {
  const parsed = attachmentFileSchema.safeParse({
    fileName: file.name,
    contentType: resolveContentType(file),
    sizeBytes: file.size,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'This file cannot be attached.' };
  return { ok: true, ...parsed.data };
}

const units = ['KB', 'MB', 'GB'];

/** "512 bytes", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export const isImage = (attachment: Pick<Attachment, 'contentType'>) => attachmentKind(attachment.contentType) === 'image';

/** Short label for a file badge: "PDF", "DOCX". */
export const fileBadge = (fileName: string) => fileExtension(fileName).toUpperCase().slice(0, 4) || 'FILE';

/** What the chat list shows for a message without text: "Photo", "3 photos", "plan.pdf", "2 files". */
export function attachmentSummary(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  const images = attachments.filter(isImage).length;
  if (images === attachments.length) return images === 1 ? 'Photo' : `${images} photos`;
  if (attachments.length === 1) return attachments[0]!.fileName;
  return `${attachments.length} files`;
}

/** Profile picture checks before uploading, matching the server's (which also checks the real content). */
export function avatarProblem(file: { type: string; size: number }): string | null {
  if (!(AVATAR_CONTENT_TYPES as readonly string[]).includes(file.type)) return 'Use a JPEG, PNG or WebP image.';
  if (file.size === 0) return 'This image is empty.';
  if (file.size > MAX_AVATAR_BYTES) return 'Profile pictures can be at most 2 MB.';
  return null;
}
