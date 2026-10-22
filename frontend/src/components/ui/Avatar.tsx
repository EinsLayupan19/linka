import { useState } from 'react';

const sizes = {
  sm: 'size-8 text-sm',
  md: 'size-10 text-base',
  lg: 'size-14 text-xl',
};

/**
 * A profile picture, or the name's initial when there is none (or it fails to load, e.g. an
 * expired signed URL). Decorative: the name is always shown next to it.
 */
export function Avatar({ name, src, size = 'md' }: { name: string; src?: string | null; size?: keyof typeof sizes }) {
  // Remember which URL failed, so a new URL is tried again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const className = `grid shrink-0 place-items-center overflow-hidden rounded-full border border-line bg-canvas font-semibold text-ink ${sizes[size]}`;

  if (src && src !== failedSrc) {
    return (
      <span aria-hidden="true" className={className}>
        <img src={src} alt="" onError={() => setFailedSrc(src)} className="size-full object-cover" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={className}>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}
