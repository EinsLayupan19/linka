import { Navigate, Route, Routes } from 'react-router';
import { RedirectIfSignedIn, RequireAuth, RequireProfile } from './components/auth/RouteGuards';
import { AppShell } from './components/layout/AppShell';
import { AuthLayout } from './components/layout/AuthLayout';
import { ForgotPassword } from './pages/ForgotPassword';
import { Login } from './pages/Login';
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
          <Route element={<AppShell />}>
            {/* Conversations take over "/" in the messaging phase. */}
            <Route index element={<Navigate to="/profile" replace />} />
            <Route path="/profile" element={<Profile />} />
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
