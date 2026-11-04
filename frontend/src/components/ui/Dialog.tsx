import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  /** Called however the dialog closes: the Close button, Escape, or a click on the backdrop. */
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A modal dialog on the browser's native <dialog>: showModal() traps focus inside it, makes the
 * page behind it inert, closes on Escape and gives focus back to whatever opened it. The content
 * is only rendered while open, so every opening starts fresh.
 */
export function Dialog({ open, onClose, title, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the backdrop lands on the <dialog> itself, never on its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="m-auto max-h-[min(42rem,calc(100dvh-2rem))] w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface p-0 text-ink shadow-lg shadow-ink/10 backdrop:bg-ink/40 open:flex open:flex-col open:animate-dialog-in motion-reduce:open:animate-none"
    >
      {open && (
        <>
          <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 id={titleId} className="truncate font-semibold">
              {title}
            </h2>
            <Button variant="secondary" onClick={() => ref.current?.close()} className="h-8 shrink-0 px-3">
              Close
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </>
      )}
    </dialog>
  );
}
