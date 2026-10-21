import { useId, type InputHTMLAttributes } from 'react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Shown under the input when there is no error. */
  hint?: string;
  error?: string | undefined;
}

/** Label above, input, then hint or error below. Errors are linked for screen readers. */
export function TextField({ label, hint, error, className = '', ...inputProps }: TextFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className={`grid gap-2 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        className={
          'h-10 w-full rounded-lg border bg-surface px-3 text-base text-ink sm:text-sm ' +
          'placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ' +
          'disabled:opacity-60 ' +
          (error ? 'border-danger' : 'border-line')
        }
        {...inputProps}
      />
      {message && (
        <p id={messageId} className={`text-sm ${error ? 'text-danger' : 'text-ink-muted'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
