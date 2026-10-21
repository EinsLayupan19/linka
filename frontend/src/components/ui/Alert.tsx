import type { ReactNode } from 'react';

const toneClassName = {
  danger: 'border-danger/40 text-danger',
  success: 'border-accent/40 text-accent',
} as const;

/** Form-level message. Errors interrupt screen readers (alert); successes are polite (status). */
export function Alert({ tone, children }: { tone: keyof typeof toneClassName; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-lg border bg-surface px-3 py-2 text-sm ${toneClassName[tone]}`}
    >
      {children}
    </div>
  );
}
