import type { ReactNode } from 'react';

/** Full-page loading placeholder: static skeleton bars, no looping animation. */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <span aria-hidden="true" className="block h-7 w-40 rounded-sm bg-skeleton" />
      <span aria-hidden="true" className="mt-4 block h-4 w-72 max-w-full rounded-sm bg-skeleton" />
      <span aria-hidden="true" className="mt-2 block h-4 w-56 max-w-full rounded-sm bg-skeleton" />
    </div>
  );
}

/** Full-page error or notice with optional actions. */
export function PageMessage({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-2 max-w-[60ch] text-ink-muted">{children}</div>
      {actions && <div className="mt-6 flex flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
