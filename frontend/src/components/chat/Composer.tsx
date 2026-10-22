import { useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH, messageContentSchema, type Attachment } from '@linka/shared';
import { useAttachmentUploads, type DraftAttachment } from '../../hooks/useAttachmentUploads';
import { ATTACHMENT_ACCEPT, fileBadge, formatBytes } from '../../utils/attachments';
import { Button, secondaryButtonClassName } from '../ui/Button';

const SHOW_COUNTER_FROM = MESSAGE_MAX_LENGTH - 500;

export interface OutgoingMessage {
  /** Undefined when the message is only attachments. */
  content?: string;
  attachments: Attachment[];
}

const smallAction =
  'rounded-sm text-xs font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

function DraftChip({ draft, onRemove, onRetry }: { draft: DraftAttachment; onRemove: () => void; onRetry: () => void }) {
  const percent = Math.round(draft.progress * 100);
  return (
    <li className={`flex w-60 shrink-0 items-center gap-2.5 rounded-lg border bg-surface p-2 ${draft.status === 'failed' ? 'border-danger' : 'border-line'}`}>
      {draft.previewUrl ? (
        <img src={draft.previewUrl} alt="" className="size-10 shrink-0 rounded-sm bg-skeleton object-cover" />
      ) : (
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-sm border border-line text-[10px] font-semibold tracking-wide text-ink-muted">
          {fileBadge(draft.fileName)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={draft.fileName}>
          {draft.fileName}
        </span>
        {draft.status === 'uploading' && (
          <span
            role="progressbar"
            aria-label={`Uploading ${draft.fileName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-1.5 block h-1 overflow-hidden rounded-full bg-skeleton"
          >
            {/* Progress follows the upload; no easing beyond a short linear catch-up. */}
            <span
              className="block h-full bg-accent transition-[width] duration-150 ease-linear motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
        )}
        {draft.status === 'ready' && <span className="block text-xs text-ink-muted">{formatBytes(draft.sizeBytes)}</span>}
        {draft.status === 'failed' && (
          <span className="block truncate text-xs text-danger" title={draft.error ?? undefined}>
            {draft.error}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {draft.status === 'failed' && draft.retryable && (
          <button type="button" onClick={onRetry} aria-label={`Retry ${draft.fileName}`} className={`${smallAction} text-accent`}>
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${draft.status === 'uploading' ? 'Cancel' : 'Remove'} ${draft.fileName}`}
          className={`${smallAction} text-ink-muted`}
        >
          {draft.status === 'uploading' ? 'Cancel' : 'Remove'}
        </button>
      </span>
    </li>
  );
}

/**
 * Message input with attachments. Enter sends, Shift+Enter adds a line. Text is sent exactly as
 * typed. Files can be picked, pasted or dropped; they upload right away and the message can be
 * sent once every file is ready.
 */
export function Composer({
  conversationId,
  onSend,
  onTyping,
  disabled = false,
}: {
  conversationId: string;
  onSend: (message: OutgoingMessage) => void;
  /** Called as the user types (the caller throttles what it broadcasts). */
  onTyping?: () => void;
  disabled?: boolean;
}) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const uploads = useAttachmentUploads(conversationId);

  function addFiles(files: File[]) {
    if (files.length === 0) return;
    setError(uploads.add(files));
  }

  function submit() {
    if (uploads.uploading || uploads.failed) return;
    const hasText = content.trim().length > 0;
    if (!hasText && uploads.readyCount === 0) return; // an empty box is not worth announcing
    let text: string | undefined;
    if (hasText) {
      const parsed = messageContentSchema.safeParse(content);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'This message cannot be sent.');
        return;
      }
      text = parsed.data;
    }
    onSend({ ...(text !== undefined ? { content: text } : {}), attachments: uploads.takeReady() });
    setContent('');
    setError(null);
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Not while composing with an input method (e.g. Japanese, Chinese).
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files];
    if (files.length === 0 || disabled) return;
    event.preventDefault();
    addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(false);
    if (!disabled) addFiles([...event.dataTransfer.files]);
  }

  const length = content.length;
  const hasContent = content.trim().length > 0 || uploads.readyCount > 0;
  const canSend = !disabled && hasContent && !uploads.uploading && !uploads.failed;
  const hint = uploads.failed
    ? 'Remove or retry the files that did not upload.'
    : uploads.uploading
      ? 'Uploading… you can send once files are ready.'
      : null;

  return (
    <form
      onSubmit={onSubmit}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files') || disabled) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className={`border-t bg-canvas px-3 py-3 sm:px-4 ${dragging ? 'border-accent outline-2 -outline-offset-2 outline-accent' : 'border-line'}`}
    >
      {uploads.drafts.length > 0 && (
        <ul aria-label="Attachments" className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {uploads.drafts.map((draft) => (
            <DraftChip
              key={draft.clientId}
              draft={draft}
              onRemove={() => uploads.remove(draft.clientId)}
              onRetry={() => uploads.retry(draft.clientId)}
            />
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = ''; // picking the same file again should work
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
          className={`${secondaryButtonClassName} px-3`}
          aria-label="Attach files"
        >
          Attach
        </button>
        <label className="sr-only" htmlFor={`${errorId}-input`}>
          Message
        </label>
        <textarea
          id={`${errorId}-input`}
          ref={inputRef}
          rows={1}
          value={content}
          disabled={disabled}
          placeholder={uploads.drafts.length > 0 ? 'Add a caption' : 'Write a message'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setContent(e.target.value);
            if (error) setError(null);
            if (e.target.value.trim()) onTyping?.();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className={
            'field-sizing-content max-h-40 min-h-10 min-w-0 flex-1 resize-none rounded-lg border bg-surface px-3 py-2 text-base text-ink sm:text-sm ' +
            'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-60 ' +
            (error ? 'border-danger' : 'border-line')
          }
        />
        <Button type="submit" disabled={!canSend}>
          Send
        </Button>
      </div>
      <div className="mt-1 flex min-h-4 justify-between gap-3 text-xs">
        <span id={errorId} role={error ? 'alert' : undefined} className="text-danger">
          {error}
        </span>
        {hint && !error && <span className="text-ink-muted">{hint}</span>}
        {length >= SHOW_COUNTER_FROM && (
          <span className={`shrink-0 ${length > MESSAGE_MAX_LENGTH ? 'text-danger' : 'text-ink-muted'}`}>
            {length} / {MESSAGE_MAX_LENGTH}
          </span>
        )}
      </div>
    </form>
  );
}
