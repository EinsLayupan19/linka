import { Link } from 'react-router';
import { buttonClassName } from '../components/ui/Button';

export function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
      <p className="text-sm font-medium text-ink-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Page not found</h1>
      <p className="mt-2 text-ink-muted">This page does not exist or has moved.</p>
      <Link to="/" className={`mt-6 ${buttonClassName}`}>
        Back to home
      </Link>
    </div>
  );
}
