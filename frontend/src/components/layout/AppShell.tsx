import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { useOptionalProfile } from '../../hooks/useProfile';
import { SignOutButton } from '../auth/SignOutButton';
import { secondaryButtonClassName } from '../ui/Button';

const focusRing = 'rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent';

function HeaderActions() {
  const { state } = useAuth();
  const profile = useOptionalProfile()?.profile;

  if (state.status === 'signed_out') {
    return (
      <Link to="/login" className={secondaryButtonClassName}>
        Log in
      </Link>
    );
  }
  if (state.status !== 'signed_in') return null;

  const navLinkClassName = ({ isActive }: { isActive: boolean }) =>
    `${focusRing} text-sm font-medium ${isActive ? 'text-ink' : 'text-ink-muted hover:text-ink'}`;

  return (
    <div className="flex min-w-0 items-center gap-3 sm:gap-4">
      {profile && (
        <nav aria-label="Main" className="flex min-w-0 items-center gap-3 sm:gap-4">
          <NavLink to="/" end className={navLinkClassName}>
            Chats
          </NavLink>
          <NavLink to="/profile" className={(state) => `${navLinkClassName(state)} max-w-[6rem] truncate sm:max-w-[9rem]`}>
            {profile.displayName}
          </NavLink>
        </nav>
      )}
      <SignOutButton />
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" className={`${focusRing} text-base font-semibold tracking-tight`}>
            Linka
          </Link>
          <HeaderActions />
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
