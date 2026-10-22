import { z } from 'zod';

/*
 * Files and media. Files live in private Supabase Storage buckets; PostgreSQL holds only
 * metadata. Clients never see or choose storage paths: they get short-lived signed URLs.
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_URLS_MAX = 50;
/** Unattached uploads older than this are removed by the server's cleanup sweep. */
export const UNATTACHED_UPLOAD_TTL_HOURS = 24;

export type AttachmentKind = 'image' | 'file';

/**
 * The only file types Linka accepts, with the extensions allowed for each.
 * SVG and HTML are deliberately absent: they can carry scripts.
 */
export const ALLOWED_ATTACHMENT_TYPES = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'application/pdf': { kind: 'file', extensions: ['pdf'] },
  'text/plain': { kind: 'file', extensions: ['txt'] },
  'application/zip': { kind: 'file', extensions: ['zip'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', extensions: ['docx'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', extensions: ['xlsx'] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'file', extensions: ['pptx'] },
} as const satisfies Record<string, { kind: AttachmentKind; extensions: readonly string[] }>;

export type AttachmentContentType = keyof typeof ALLOWED_ATTACHMENT_TYPES;
export const ATTACHMENT_CONTENT_TYPES = Object.keys(ALLOWED_ATTACHMENT_TYPES) as [
  AttachmentContentType,
  ...AttachmentContentType[],
];

/** Profile pictures: images only. */
export const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export function attachmentKind(contentType: AttachmentContentType): AttachmentKind {
  return ALLOWED_ATTACHMENT_TYPES[contentType].kind;
}

export function maxBytesFor(contentType: AttachmentContentType): number {
  return attachmentKind(contentType) === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
}

/** The lowercase extension of a file name, or '' if it has none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/**
 * A display name for a file. It is never used to build a storage path, but it is shown to other
 * people and offered as the download name, so anything that looks like a path or contains
 * control characters is rejected outright rather than silently rewritten.
 */
export const fileNameSchema = z
  .string()
  .min(1, 'The file needs a name.')
  .max(255, 'File names can be at most 255 characters.')
  .refine((name) => name.trim() === name && name.trim().length > 0, 'File names cannot start or end with spaces.')
  .refine((name) => !/[/\\]/.test(name), 'File names cannot contain / or \\.')
  // eslint-disable-next-line no-control-regex
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), 'File names cannot contain control characters.')
  // Invisible and direction-changing characters can disguise a name ("invoice<RLO>fdp.png" shows as
  // "invoicegnp.pdf"), so they are refused too.
  .refine((name) => !/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(name), 'File names cannot contain invisible characters.')
  .refine((name) => name !== '.' && name !== '..', 'Invalid file name.');

const fileFields = {
  fileName: fileNameSchema,
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES, 'This type of file is not supported.'),
  sizeBytes: z.number().int('Invalid file size.').min(1, 'This file is empty.'),
};

/** The extension must belong to the type, and the size must fit the type's limit. */
function checkFile(file: { fileName: string; contentType: AttachmentContentType; sizeBytes: number }, ctx: z.RefinementCtx) {
  const allowed: readonly string[] = ALLOWED_ATTACHMENT_TYPES[file.contentType].extensions;
  if (!allowed.includes(fileExtension(file.fileName))) {
    ctx.addIssue({
      code: 'custom',
      path: ['fileName'],
      message: `The file name must end in .${allowed.join(' or .')} for this type of file.`,
    });
  }
  const limit = maxBytesFor(file.contentType);
  if (file.sizeBytes > limit) {
    ctx.addIssue({
      code: 'custom',
      path: ['sizeBytes'],
      message: `This file is too large (max ${Math.round(limit / 1024 / 1024)} MB).`,
    });
  }
}

/** Validates name, type, extension and size together (used by the composer before uploading). */
export const attachmentFileSchema = z.object(fileFields).superRefine(checkFile);

/** Body of POST /api/conversations/:conversationId/attachments (start an upload). */
export const createAttachmentUploadSchema = z
  .strictObject({
    /** Generated by the client; starting the same upload again returns the same attachment. */
    clientId: z.uuid('Invalid client id.'),
    ...fileFields,
  })
  .superRefine(checkFile);

export type CreateAttachmentUploadInput = z.infer<typeof createAttachmentUploadSchema>;

export const ATTACHMENT_STATUSES = ['pending', 'ready'] as const;
export const attachmentStatusSchema = z.enum(ATTACHMENT_STATUSES);
export type AttachmentStatus = z.infer<typeof attachmentStatusSchema>;

/** An attachment as members see it. No storage path, no URL (those are fetched separately). */
export const attachmentSchema = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().positive(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/** The caller's own upload, before it is attached to a message. */
export const attachmentUploadSchema = attachmentSchema.extend({
  conversationId: z.uuid(),
  status: attachmentStatusSchema,
});

export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

/** Response of POST .../attachments: where to PUT the file (null once it is uploaded). */
export const attachmentUploadResponseSchema = z.object({
  attachment: attachmentUploadSchema,
  upload: z
    .object({
      /** Single-use signed upload URL for exactly this file. */
      url: z.url(),
      expiresAt: z.iso.datetime(),
    })
    .nullable(),
});

export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;

/** Body of POST /api/attachments/urls. */
export const attachmentUrlsRequestSchema = z.strictObject({
  attachmentIds: z
    .array(z.uuid('Invalid attachment id.'))
    .min(1)
    .max(ATTACHMENT_URLS_MAX, `At most ${ATTACHMENT_URLS_MAX} attachments per request.`),
});

export const attachmentUrlsResponseSchema = z.object({
  /** Only attachments the caller may see; others are simply absent. */
  urls: z.array(z.object({ id: z.uuid(), url: z.url(), expiresAt: z.iso.datetime() })),
});

export type AttachmentUrlsResponse = z.infer<typeof attachmentUrlsResponseSchema>;
