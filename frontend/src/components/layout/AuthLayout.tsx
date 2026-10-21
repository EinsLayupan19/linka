import { Link, Outlet } from 'react-router';

/** Layout for sign-in pages: a narrow, left-aligned column with the wordmark. */
export function AuthLayout() {
  return (
    <div className="min-h-[100dvh] px-4 py-10 sm:py-16">
      <div className="mx-auto w-full max-w-sm">
        <Link
          to="/"
          className="rounded-lg text-base font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          Linka
        </Link>
        <main className="mt-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
