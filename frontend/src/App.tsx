import { Route, Routes } from 'react-router';
import { RedirectIfSignedIn, RequireAuth, RequireProfile } from './components/auth/RouteGuards';
import { AppShell } from './components/layout/AppShell';
import { AuthLayout } from './components/layout/AuthLayout';
import { SignedInLayout } from './components/layout/SignedInLayout';
import { Chat } from './pages/Chat';
import { Chats, ChatsHome } from './pages/Chats';
import { ForgotPassword } from './pages/ForgotPassword';
import { Login } from './pages/Login';
import { NewChat } from './pages/NewChat';
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/Onboarding';
import { Profile } from './pages/Profile';
import { Register } from './pages/Register';
import { ResetPassword } from './pages/ResetPassword';
import { Status } from './pages/Status';

export function App() {
  return (
    <Routes>
      {/* Signed-out pages */}
      <Route element={<AuthLayout />}>
        <Route element={<RedirectIfSignedIn />}>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
        </Route>
        {/* Reached from the reset email, which signs the user in. */}
        <Route path="/reset-password" element={<ResetPassword />} />
      </Route>

      {/* Signed-in pages */}
      <Route element={<RequireAuth />}>
        <Route element={<AuthLayout />}>
          <Route path="/onboarding" element={<Onboarding />} />
        </Route>
        <Route element={<RequireProfile />}>
          {/* The conversation list and calls live here, so a call rings on every signed-in page. */}
          <Route element={<SignedInLayout />}>
            <Route element={<AppShell />}>
              <Route element={<Chats />}>
                <Route index element={<ChatsHome />} />
                <Route path="/conversations/new" element={<NewChat />} />
                <Route path="/conversations/:conversationId" element={<Chat />} />
              </Route>
              <Route path="/profile" element={<Profile />} />
            </Route>
          </Route>
        </Route>
      </Route>

      {/* Public pages */}
      <Route element={<AppShell />}>
        <Route path="/status" element={<Status />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
