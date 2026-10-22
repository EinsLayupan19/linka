import { typingLabel } from '../../utils/receipts';

/**
 * "Jonas is typing…". Always takes the same height, so the conversation does not jump when it
 * appears or disappears. No animation: it changes too often for motion to help.
 */
export function TypingIndicator({ names }: { names: string[] }) {
  const label = typingLabel(names);
  return (
    <p aria-live="polite" className="h-6 truncate px-4 text-xs leading-6 text-ink-muted">
      {label}
    </p>
  );
}
