import type { ButtonHTMLAttributes } from 'react';

// Motion: a 150ms color change and a slight press-down for feedback; both are
// removed when the user prefers reduced motion.
const base =
  'inline-flex h-10 items-center justify-center rounded-lg px-4 text-sm font-medium ' +
  'transition-[background-color,border-color,transform] duration-150 ease-out-quick active:scale-[0.98] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ' +
  'disabled:pointer-events-none disabled:opacity-50 ' +
  'motion-reduce:transition-none motion-reduce:active:scale-100';

// Exported so links that look like buttons (e.g. "Back to home") match exactly.
export const buttonClassName = `${base} bg-accent text-on-accent hover:bg-accent-hover`;
export const secondaryButtonClassName = `${base} border border-line bg-surface text-ink hover:border-ink-muted`;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ className = '', type = 'button', variant = 'primary', ...props }: ButtonProps) {
  const variantClassName = variant === 'primary' ? buttonClassName : secondaryButtonClassName;
  return <button type={type} className={`${variantClassName} ${className}`} {...props} />;
}
