import type { LiveStatus } from '../../services/realtime';

/**
 * Tells the user, in plain words, when new messages are not arriving live.
 * Nothing is shown while connected (or during the first quick connect).
 */
export function LiveStatusNotice({ status }: { status: LiveStatus }) {
  if (status !== 'reconnecting') return null;
  return (
    <p role="status" className="border-t border-line bg-surface px-4 py-2 text-sm text-warning">
      Reconnecting… You can still send messages. New ones will appear when the connection is back.
    </p>
  );
}
