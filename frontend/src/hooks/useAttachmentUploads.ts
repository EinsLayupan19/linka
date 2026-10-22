import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENTS_PER_MESSAGE, type Attachment, type AttachmentContentType } from '@linka/shared';
import { ApiError, toApiError } from '../lib/api';
import { cancelUpload, completeUpload, putFile, startUpload } from '../services/attachments';
import { checkFile, isImage } from '../utils/attachments';

/** A file in the composer, from picking it until the message that carries it is sent. */
export interface DraftAttachment {
  /** Stable key, and the upload's idempotency key: retries reuse it. */
  clientId: string;
  fileName: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  /** Local object URL for image thumbnails. */
  previewUrl: string | null;
  status: 'uploading' | 'ready' | 'failed';
  /** 0 to 1 while uploading. */
  progress: number;
  error: string | null;
  /** Whether trying again can help (not when the file itself was rejected). */
  retryable: boolean;
  /** Set once the upload is verified. */
  attachment: Attachment | null;
}

interface Tracked {
  file: File;
  controller: AbortController | null;
  /** Known once the server recorded the upload; needed to delete it on cancel. */
  attachmentId: string | null;
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Uploads for one conversation's composer. Files upload as soon as they are added (straight to
 * Storage through a signed URL), so sending is instant once they are ready.
 *
 * - Removing a file aborts its upload and deletes what the server already has.
 * - Leaving the conversation does the same for every unsent file.
 * - Anything left behind anyway (closed tab, lost network) is deleted by the server's cleanup
 *   sweep after a day.
 */
export function useAttachmentUploads(conversationId: string) {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const tracked = useRef(new Map<string, Tracked>());

  const update = useCallback((clientId: string, patch: Partial<DraftAttachment>) => {
    setDrafts((current) => current.map((d) => (d.clientId === clientId ? { ...d, ...patch } : d)));
  }, []);

  const upload = useCallback(
    async (draft: Pick<DraftAttachment, 'clientId' | 'fileName' | 'contentType' | 'sizeBytes'>) => {
      const entry = tracked.current.get(draft.clientId);
      if (!entry) return;
      entry.controller?.abort();
      const controller = new AbortController();
      entry.controller = controller;
      const { signal } = controller;

      try {
        const { attachment, upload: target } = await startUpload(
          conversationId,
          { clientId: draft.clientId, fileName: draft.fileName, contentType: draft.contentType, sizeBytes: draft.sizeBytes },
          signal,
        );
        entry.attachmentId = attachment.id;
        if (target) {
          try {
            await putFile(target.url, entry.file, draft.contentType, {
              signal,
              onProgress: (progress) => update(draft.clientId, { progress }),
            });
          } catch (error) {
            // A retry after a PUT that did arrive is refused ("already exists"): the file is
            // there, so carry on and let the server check it.
            if (!(error instanceof ApiError && (error.status === 400 || error.status === 409))) throw error;
          }
        }
        const ready = await completeUpload(attachment.id, signal);
        if (signal.aborted) return;
        entry.controller = null;
        update(draft.clientId, {
          status: 'ready',
          progress: 1,
          error: null,
          attachment: { id: ready.id, fileName: ready.fileName, contentType: ready.contentType, sizeBytes: ready.sizeBytes },
        });
      } catch (error) {
        if (isAbort(error) || signal.aborted) return;
        entry.controller = null;
        const apiError = toApiError(error);
        // A rejected file was already deleted by the server; trying again cannot help.
        const rejected = apiError.code === 'UPLOAD_REJECTED' || apiError.status === 400;
        if (rejected) entry.attachmentId = null;
        update(draft.clientId, { status: 'failed', error: apiError.message, retryable: !rejected });
      }
    },
    [conversationId, update],
  );

  /** Adds files and starts uploading them. Returns a message for files that cannot be attached. */
  const add = useCallback(
    (files: File[]): string | null => {
      const room = MAX_ATTACHMENTS_PER_MESSAGE - tracked.current.size;
      const problems: string[] = [];
      const accepted: DraftAttachment[] = [];
      for (const file of files) {
        if (accepted.length >= room) {
          problems.push(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to a message.`);
          break;
        }
        const check = checkFile(file);
        if (!check.ok) {
          problems.push(`${file.name || 'File'}: ${check.error}`);
          continue;
        }
        const clientId = crypto.randomUUID();
        const draft: DraftAttachment = {
          clientId,
          fileName: check.fileName,
          contentType: check.contentType,
          sizeBytes: check.sizeBytes,
          previewUrl: isImage(check) ? URL.createObjectURL(file) : null,
          status: 'uploading',
          progress: 0,
          error: null,
          retryable: true,
          attachment: null,
        };
        tracked.current.set(clientId, { file, controller: null, attachmentId: null });
        accepted.push(draft);
      }
      if (accepted.length > 0) {
        setDrafts((current) => [...current, ...accepted]);
        for (const draft of accepted) void upload(draft);
      }
      return problems.length > 0 ? problems.join(' ') : null;
    },
    [upload],
  );

  const discard = useCallback((clientId: string, { deleteOnServer }: { deleteOnServer: boolean }) => {
    const entry = tracked.current.get(clientId);
    tracked.current.delete(clientId);
    if (!entry) return;
    entry.controller?.abort();
    // Best effort: whatever is not deleted here is removed by the server's cleanup sweep.
    if (deleteOnServer && entry.attachmentId) cancelUpload(entry.attachmentId).catch(() => undefined);
  }, []);

  const remove = useCallback(
    (clientId: string) => {
      discard(clientId, { deleteOnServer: true });
      const previewUrl = drafts.find((d) => d.clientId === clientId)?.previewUrl;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setDrafts((current) => current.filter((d) => d.clientId !== clientId));
    },
    [discard, drafts],
  );

  const retry = useCallback(
    (clientId: string) => {
      const draft = drafts.find((d) => d.clientId === clientId);
      if (!draft || draft.status !== 'failed' || !draft.retryable) return;
      update(clientId, { status: 'uploading', progress: 0, error: null });
      void upload(draft);
    },
    [drafts, update, upload],
  );

  /** Hands the ready attachments to a message being sent and clears the composer. */
  const takeReady = useCallback((): Attachment[] => {
    const ready = drafts.flatMap((d) => (d.status === 'ready' && d.attachment ? [d.attachment] : []));
    for (const draft of drafts) {
      // Sent attachments now belong to the message: never delete them.
      discard(draft.clientId, { deleteOnServer: draft.status !== 'ready' });
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    }
    setDrafts([]);
    return ready;
  }, [discard, drafts]);

  // Leaving the conversation: stop uploads and delete unsent files.
  const latestDrafts = useRef(drafts);
  useEffect(() => {
    latestDrafts.current = drafts;
  });
  useEffect(() => {
    const entries = tracked.current;
    return () => {
      for (const clientId of [...entries.keys()]) discard(clientId, { deleteOnServer: true });
      for (const draft of latestDrafts.current) if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    };
  }, [discard]);

  return {
    drafts,
    add,
    remove,
    retry,
    takeReady,
    uploading: drafts.some((d) => d.status === 'uploading'),
    failed: drafts.some((d) => d.status === 'failed'),
    readyCount: drafts.filter((d) => d.status === 'ready').length,
  };
}
