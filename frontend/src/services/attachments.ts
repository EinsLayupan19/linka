import {
  attachmentUploadResponseSchema,
  attachmentUploadSchema,
  attachmentUrlsResponseSchema,
  type AttachmentContentType,
  type AttachmentUpload,
  type AttachmentUploadResponse,
  type AttachmentUrlsResponse,
} from '@linka/shared';
import { z } from 'zod';
import { ApiError, apiRequest, ClientErrorCode } from '../lib/api';

/**
 * Attachment uploads, in three steps:
 * 1. start: the API records a pending upload and returns a single-use signed upload URL
 * 2. the browser PUTs the file straight to Storage at that URL (no file bytes pass through
 *    the API, and the browser never holds a storage key)
 * 3. complete: the API checks what actually arrived (size, type, real content) and marks it ready
 */

/** Step 1. Retrying with the same clientId returns the same upload. */
export function startUpload(
  conversationId: string,
  input: { clientId: string; fileName: string; contentType: AttachmentContentType; sizeBytes: number },
  signal?: AbortSignal,
): Promise<AttachmentUploadResponse> {
  return apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, attachmentUploadResponseSchema, {
    auth: true,
    method: 'POST',
    json: input,
    signal: signal ?? null,
  });
}

/** Step 3. */
export function completeUpload(attachmentId: string, signal?: AbortSignal): Promise<AttachmentUpload> {
  return apiRequest(`/api/attachments/${encodeURIComponent(attachmentId)}/complete`, attachmentUploadSchema, {
    auth: true,
    method: 'POST',
    signal: signal ?? null,
  });
}

/** Deletes an unsent upload (row and file). */
export function cancelUpload(attachmentId: string): Promise<void> {
  return apiRequest(`/api/attachments/${encodeURIComponent(attachmentId)}`, z.undefined(), { auth: true, method: 'DELETE' });
}

/** Short-lived download URLs; attachments the caller may not see are left out. */
export function getAttachmentUrls(attachmentIds: string[]): Promise<AttachmentUrlsResponse> {
  return apiRequest('/api/attachments/urls', attachmentUrlsResponseSchema, { auth: true, method: 'POST', json: { attachmentIds } });
}

/**
 * Step 2: PUTs the file to its signed upload URL, reporting progress (0 to 1). Uses XHR because
 * fetch cannot report upload progress. Rejects with an AbortError when `signal` aborts.
 */
export function putFile(
  url: string,
  file: Blob,
  contentType: string,
  { onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => signal?.removeEventListener('abort', onAbort);

    xhr.open('PUT', url);
    // The stored type must match what the API recorded, or completing the upload fails.
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
      } else {
        reject(new ApiError(xhr.status, ClientErrorCode.Unknown, 'The upload did not go through. Try again.'));
      }
    };
    xhr.onerror = () => {
      done();
      reject(new ApiError(0, ClientErrorCode.Network, 'Could not upload the file. Check your connection and try again.'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    xhr.send(file);
  });
}
