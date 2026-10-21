export type StatusTone = 'ok' | 'warning' | 'danger' | 'neutral';

export type StatusRowProps =
  | { label: string; loading: true }
  | { label: string; loading?: false; tone: StatusTone; value: string; detail: string };

const toneClassName: Record<StatusTone, string> = {
  ok: 'text-accent',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-ink-muted',
};

export function StatusRow(props: StatusRowProps) {
  return (
    <li className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-4 sm:px-5">
      <span className="font-medium">{props.label}</span>

      {props.loading ? (
        <>
          {/* Static placeholders sized like the real text, so nothing shifts when results arrive. */}
          <span aria-hidden="true" className="mt-1 block h-4 w-20 justify-self-end rounded-sm bg-skeleton" />
          <span aria-hidden="true" className="col-span-2 mt-1 block h-4 w-3/5 rounded-sm bg-skeleton" />
          <span className="sr-only">Checking</span>
        </>
      ) : (
        <>
          <span className={`text-sm font-medium ${toneClassName[props.tone]}`}>{props.value}</span>
          <span className="col-span-2 text-sm text-ink-muted">{props.detail}</span>
        </>
      )}
    </li>
  );
}
