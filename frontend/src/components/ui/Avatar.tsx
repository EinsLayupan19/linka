/** Initial in a circle. Stands in for profile pictures until avatar uploads exist. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const sizeClassName = size === 'sm' ? 'size-8 text-sm' : 'size-10 text-base';
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full border border-line bg-canvas font-semibold text-ink ${sizeClassName}`}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
