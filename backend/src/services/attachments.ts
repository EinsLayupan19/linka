import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  ErrorCode,
  fileExtension,
  UNATTACHED_UPLOAD_TTL_HOURS,
  type Attachment,
  type AttachmentUpload,
  type AttachmentUploadResponse,
  type AttachmentUrlsResponse,
  type CreateAttachmentUploadInput,
} from '@linka/shared';
import type { Database } from '../db/client.js';
import { postgresErrorCode, UNIQUE_VIOLATION } from '../db/errors.js';
import { conversationMembers, messageAttachments, type MessageAttachmentRow } from '../db/schema/index.js';
import { AppError } from '../utils/AppError.js';
import { matchesSignature, SIGNATURE_BYTES } from '../utils/fileSignature.js';
import { requireMembership } from './membership.js';
import type { StorageGateway } from './storage.js';

/** Download URLs live 10 minutes; clients ask again when they need a fresh one. */
export const ATTACHMENT_URL_TTL_SECONDS = 600;
const BUCKET = 'attachments';

/**
 * The upload lifecycle. Bytes go from the browser straight to private Storage (never through
 * Express); the API decides where they may go and checks what arrived:
 *
 *   start    -> row `pending` + single-use signed upload URL for a server-chosen path
 *   (browser PUTs the file to that URL)
 *   complete -> server inspects the stored object (size, type, first bytes) -> `ready`,
 *               or deletes it if it does not match what was declared
 *   send     -> the messages service links `ready` uploads to a message (see messages.ts)
 *   cancel   -> the uploader deletes an unsent upload
 *   sweep    -> unsent uploads older than UNATTACHED_UPLOAD_TTL_HOURS are removed
 */
export interface AttachmentStore {
  start(userId: string, conversationId: string, input: CreateAttachmentUploadInput): Promise<{ response: AttachmentUploadResponse; created: boolean }>;
  complete(userId: string, attachmentId: string): Promise<AttachmentUpload>;
  cancel(userId: string, attachmentId: string): Promise<void>;
  signedUrls(userId: string, attachmentIds: string[]): Promise<AttachmentUrlsResponse>;
  /** Removes unsent uploads older than the TTL. Returns how many were removed. */
  sweepUnattached(now?: Date, limit?: number): Promise<number>;
}

const notFound = () => new AppError(404, ErrorCode.AttachmentNotFound, 'Attachment not found.');

function toUpload(row: MessageAttachmentRow): AttachmentUpload {
  return {
    id: row.id,
    conversationId: row.conversationId,
    fileName: row.fileName,
    contentType: row.contentType as Attachment['contentType'],
    sizeBytes: row.sizeBytes,
    status: row.status,
  };
}

export function createAttachmentStore(db: Database, storage: StorageGateway | null): AttachmentStore {
  function requireStorage(): StorageGateway {
    if (!storage) throw new AppError(503, ErrorCode.ServiceUnavailable, 'File uploads are not configured on the server.');
    return storage;
  }

  /** The caller's own attachment (any other id answers like one that does not exist). */
  async function ownAttachment(userId: string, attachmentId: string): Promise<MessageAttachmentRow> {
    const [row] = await db
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.uploaderId, userId)))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  async function findByClientId(userId: string, clientId: string) {
    const [row] = await db
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.uploaderId, userId), eq(messageAttachments.clientId, clientId)))
      .limit(1);
    return row;
  }

  async function respond(row: MessageAttachmentRow, gateway: StorageGateway): Promise<AttachmentUploadResponse> {
    // Uploaded already (or sent): nothing left to upload.
    if (row.status !== 'pending') return { attachment: toUpload(row), upload: null };
    const { url, expiresAt } = await gateway.createUploadUrl(BUCKET, row.storagePath);
    return { attachment: toUpload(row), upload: { url, expiresAt: expiresAt.toISOString() } };
  }

  return {
    async start(userId, conversationId, input) {
      await requireMembership(db, conversationId, userId);
      const gateway = requireStorage();

      // A retry of an upload that was already started: same row, a fresh upload URL if needed.
      const existing = await findByClientId(userId, input.clientId);
      if (existing) {
        if (existing.conversationId !== conversationId) {
          throw new AppError(409, ErrorCode.BadRequest, 'This client id was already used for another upload.');
        }
        return { response: await respond(existing, gateway), created: false };
      }

      // The path is chosen here, never by the client: conversation, uploader, attachment id.
      const id = randomUUID();
      const storagePath = `${conversationId}/${userId}/${id}.${fileExtension(input.fileName)}`;
      let row: MessageAttachmentRow | undefined;
      try {
        [row] = await db
          .insert(messageAttachments)
          .values({
            id,
            conversationId,
            uploaderId: userId,
            clientId: input.clientId,
            status: 'pending',
            storagePath,
            fileName: input.fileName,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
          })
          .returning();
      } catch (error) {
        // The same retry raced the first attempt.
        if (postgresErrorCode(error) === UNIQUE_VIOLATION) {
          const winner = await findByClientId(userId, input.clientId);
          if (winner && winner.conversationId === conversationId) return { response: await respond(winner, gateway), created: false };
        }
        throw error;
      }
      if (!row) throw new Error('Insert returned no row');
      return { response: await respond(row, gateway), created: true };
    },

    async complete(userId, attachmentId) {
      const row = await ownAttachment(userId, attachmentId);
      await requireMembership(db, row.conversationId, userId);
      if (row.status === 'ready') return toUpload(row); // completing twice is fine
      const gateway = requireStorage();

      const stored = await gateway.inspect(BUCKET, row.storagePath, SIGNATURE_BYTES);
      if (!stored) throw new AppError(409, ErrorCode.UploadIncomplete, 'The file has not finished uploading.');

      // The declared name, type and size were claims; check what actually arrived. Only the media
      // type counts ("text/plain;charset=UTF-8" is text/plain).
      const storedType = stored.contentType?.split(';')[0]?.trim().toLowerCase();
      const problem =
        stored.sizeBytes !== row.sizeBytes
          ? 'The uploaded file does not have the declared size.'
          : storedType !== row.contentType
            ? 'The uploaded file does not have the declared type.'
            : !matchesSignature(stored.head, row.contentType)
              ? 'The file content does not match its type.'
              : null;
      if (problem) {
        // Discard it entirely: the object first, then the row (the client may start over).
        await gateway.remove(BUCKET, [row.storagePath]);
        await db.delete(messageAttachments).where(and(eq(messageAttachments.id, row.id), isNull(messageAttachments.messageId)));
        throw new AppError(422, ErrorCode.UploadRejected, problem);
      }

      const [ready] = await db
        .update(messageAttachments)
        .set({ status: 'ready' })
        .where(eq(messageAttachments.id, row.id))
        .returning();
      if (!ready) throw notFound(); // swept in the meantime
      return toUpload(ready);
    },

    async cancel(userId, attachmentId) {
      const row = await ownAttachment(userId, attachmentId);
      if (row.messageId) throw new AppError(409, ErrorCode.AttachmentInUse, 'This attachment was already sent.');
      const gateway = requireStorage();
      // Claim the row first so it cannot be sent while its file is being deleted.
      const [claimed] = await db
        .delete(messageAttachments)
        .where(and(eq(messageAttachments.id, row.id), isNull(messageAttachments.messageId)))
        .returning({ storagePath: messageAttachments.storagePath });
      if (!claimed) throw new AppError(409, ErrorCode.AttachmentInUse, 'This attachment was already sent.');
      await gateway.remove(BUCKET, [claimed.storagePath]);
    },

    async signedUrls(userId, attachmentIds) {
      const gateway = requireStorage();
      // Only attachments the caller may see: in a conversation they belong to, and either sent
      // or their own unsent upload. Everything else is silently left out.
      const rows = await db
        .select({ id: messageAttachments.id, storagePath: messageAttachments.storagePath })
        .from(messageAttachments)
        .innerJoin(
          conversationMembers,
          and(
            eq(conversationMembers.conversationId, messageAttachments.conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
        .where(
          and(
            inArray(messageAttachments.id, [...new Set(attachmentIds)]),
            eq(messageAttachments.status, 'ready'),
            sql`(${messageAttachments.messageId} is not null or ${messageAttachments.uploaderId} = ${userId})`,
          ),
        );

      const signed = await gateway.signedUrls(
        BUCKET,
        rows.map((r) => r.storagePath),
        ATTACHMENT_URL_TTL_SECONDS,
      );
      const expiresAt = new Date(Date.now() + ATTACHMENT_URL_TTL_SECONDS * 1000).toISOString();
      return {
        urls: rows.flatMap((r) => {
          const url = signed.get(r.storagePath);
          return url ? [{ id: r.id, url, expiresAt }] : [];
        }),
      };
    },

    async sweepUnattached(now = new Date(), limit = 100) {
      const gateway = requireStorage();
      const cutoff = new Date(now.getTime() - UNATTACHED_UPLOAD_TTL_HOURS * 60 * 60 * 1000);
      const candidates = await db
        .select({ id: messageAttachments.id })
        .from(messageAttachments)
        .where(and(isNull(messageAttachments.messageId), lt(messageAttachments.createdAt, cutoff)))
        .orderBy(asc(messageAttachments.createdAt))
        .limit(limit);
      if (candidates.length === 0) return 0;

      // Delete the rows first (only if still unsent), so a send racing the sweep either wins and
      // keeps its file, or fails cleanly. Then delete the files. If Storage fails here, the
      // object is orphaned but nothing references it.
      const removed = await db
        .delete(messageAttachments)
        .where(and(inArray(messageAttachments.id, candidates.map((c) => c.id)), isNull(messageAttachments.messageId)))
        .returning({ storagePath: messageAttachments.storagePath });
      if (removed.length > 0) await gateway.remove(BUCKET, removed.map((r) => r.storagePath));
      return removed.length;
    },
  };
}
