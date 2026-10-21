import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MESSAGE_MAX_LENGTH, messageContentSchema } from '@linka/shared';
import { Button } from '../ui/Button';

const SHOW_COUNTER_FROM = MESSAGE_MAX_LENGTH - 500;

/** Message input. Enter sends, Shift+Enter adds a line. Text is sent exactly as typed. */
export function Composer({ onSend, disabled = false }: { onSend: (content: string) => void; disabled?: boolean }) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const errorId = useId();

  function submit() {
    const parsed = messageContentSchema.safeParse(content);
    if (!parsed.success) {
      // An empty box is not an error worth announcing; too long is.
      if (content.trim()) setError(parsed.error.issues[0]?.message ?? 'This message cannot be sent.');
      return;
    }
    onSend(parsed.data);
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

  const length = content.length;
  const canSend = !disabled && content.trim().length > 0;

  return (
    <form onSubmit={onSubmit} className="border-t border-line bg-canvas px-3 py-3 sm:px-4">
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${errorId}-input`}>
          Message
        </label>
        <textarea
          id={`${errorId}-input`}
          ref={inputRef}
          rows={1}
          value={content}
          disabled={disabled}
          placeholder="Write a message"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setContent(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          className={
            'field-sizing-content max-h-40 min-h-10 flex-1 resize-none rounded-lg border bg-surface px-3 py-2 text-base text-ink sm:text-sm ' +
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
        {length >= SHOW_COUNTER_FROM && (
          <span className={length > MESSAGE_MAX_LENGTH ? 'text-danger' : 'text-ink-muted'}>
            {length} / {MESSAGE_MAX_LENGTH}
          </span>
        )}
      </div>
    </form>
  );
}
