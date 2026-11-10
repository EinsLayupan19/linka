import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { RedirectIfSignedIn, RequireAuth, RequireProfile } from './components/auth/RouteGuards';
import { AppShell } from './components/layout/AppShell';
import { AuthLayout } from './components/layout/AuthLayout';
import { PageAnnouncer } from './components/layout/PageAnnouncer';
import { PageLoading } from './components/layout/PageStatus';
import { ServerWakeNotice } from './components/layout/ServerWakeNotice';
import { SignedInLayout } from './components/layout/SignedInLayout';
import { Chat } from './pages/Chat';
import { Chats, ChatsHome } from './pages/Chats';

/**
 * Code splitting: the chats and the open conversation (what a signed-in user opens most) are in
 * the main bundle; every other page is loaded the first time it is needed, as its own small file.
 */
function lazyPage<T extends Record<string, ComponentType>>(load: () => Promise<T>, name: keyof T) {
  return lazy(async () => ({ default: (await load())[name]! }));
}

const Login = lazyPage(() => import('./pages/Login'), 'Login');
const Register = lazyPage(() => import('./pages/Register'), 'Register');
const ForgotPassword = lazyPage(() => import('./pages/ForgotPassword'), 'ForgotPassword');
const ResetPassword = lazyPage(() => import('./pages/ResetPassword'), 'ResetPassword');
const Onboarding = lazyPage(() => import('./pages/Onboarding'), 'Onboarding');
const NewChat = lazyPage(() => import('./pages/NewChat'), 'NewChat');
const NewGroup = lazyPage(() => import('./pages/NewGroup'), 'NewGroup');
const Profile = lazyPage(() => import('./pages/Profile'), 'Profile');
const Status = lazyPage(() => import('./pages/Status'), 'Status');
const NotFound = lazyPage(() => import('./pages/NotFound'), 'NotFound');

/** A page of its own while it loads: the same static placeholder as other page loads. */
const page = (element: ReactNode) => <Suspense fallback={<PageLoading />}>{element}</Suspense>;
/** A page in the chat pane: an empty pane while it loads, so the conversation list stays put. */
const pane = (element: ReactNode) => (
  <Suspense fallback={<div role="status" aria-label="Loading" className="flex-1" />}>{element}</Suspense>
);

export function App() {
  return (
    <>
      <PageAnnouncer />
      <AppRoutes />
      <ServerWakeNotice />
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>
      {/* Signed-out pages */}
      <Route element={<AuthLayout />}>
        <Route element={<RedirectIfSignedIn />}>
          <Route path="/login" element={page(<Login />)} />
          <Route path="/register" element={page(<Register />)} />
          <Route path="/forgot-password" element={page(<ForgotPassword />)} />
        </Route>
        {/* Reached from the reset email, which signs the user in. */}
        <Route path="/reset-password" element={page(<ResetPassword />)} />
      </Route>

      {/* Signed-in pages */}
      <Route element={<RequireAuth />}>
        <Route element={<AuthLayout />}>
          <Route path="/onboarding" element={page(<Onboarding />)} />
        </Route>
        <Route element={<RequireProfile />}>
          {/* The conversation list and calls live here, so a call rings on every signed-in page. */}
          <Route element={<SignedInLayout />}>
            <Route element={<AppShell />}>
              <Route element={<Chats />}>
                <Route index element={<ChatsHome />} />
                <Route path="/conversations/new" element={pane(<NewChat />)} />
                <Route path="/conversations/new/group" element={pane(<NewGroup />)} />
                <Route path="/conversations/:conversationId" element={<Chat />} />
              </Route>
              <Route path="/profile" element={page(<Profile />)} />
            </Route>
          </Route>
        </Route>
      </Route>

      {/* Public pages */}
      <Route element={<AppShell />}>
        <Route path="/status" element={page(<Status />)} />
        <Route path="*" element={page(<NotFound />)} />
      </Route>
    </Routes>
  );
}
