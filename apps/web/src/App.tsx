import { lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { RoleName } from '@teachgrow/shared';
import { useAuth } from './lib/auth';
import { homeFor } from './lib/routes';
import { AppShell } from './components/layout/app-shell';
import { Button } from './components/ui/button';
import { SpinnerIcon } from './components/ui/icons';
import { ChangePasswordPage } from './pages/change-password';
import { LoginPage } from './pages/login';
import { ProfilePage } from './pages/profile';

// The administrator's and operator's pages are only fetched by the people who open them.
const QrManagementPage = lazy(() =>
  import('./pages/qr-management').then((m) => ({ default: m.QrManagementPage })),
);
const AddEmployeePage = lazy(() =>
  import('./pages/add-employee').then((m) => ({ default: m.AddEmployeePage })),
);
const ScannerPage = lazy(() => import('./pages/scanner').then((m) => ({ default: m.ScannerPage })));

function FullScreenMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-bold">{title}</h1>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </div>
  );
}

/** Everything inside needs a signed-in person; the loading and signed-out states are handled once, here. */
function RequireAuth() {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div role="status" className="flex min-h-dvh items-center justify-center text-muted">
        <SpinnerIcon className="h-8 w-8" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  if (status === 'signedOut' || !user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}

function RequireRole({ roles }: { roles: RoleName[] }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) {
    return (
      <FullScreenMessage title="You do not have access to this page">
        <p>Your account type cannot use this part of the app.</p>
        <Button className="mt-3" onClick={() => window.history.back()} variant="outline">
          Go back
        </Button>
      </FullScreenMessage>
    );
  }
  return <Outlet />;
}

function Home() {
  const { user } = useAuth();
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route element={<RequireRole roles={['admin', 'attendance_operator']} />}>
            <Route path="/scanner" element={<ScannerPage />} />
          </Route>
          <Route element={<RequireRole roles={['admin']} />}>
            <Route path="/admin/qr" element={<QrManagementPage />} />
            <Route path="/admin/employees/new" element={<AddEmployeePage />} />
          </Route>
          <Route
            path="/unsupported"
            element={
              <FullScreenMessage title="This account is for the lobby screen">
                The office display account does not use this app. Sign out and sign in with your own
                account.
              </FullScreenMessage>
            }
          />
          <Route path="*" element={<FullScreenMessage title="Page not found" />} />
        </Route>
      </Route>
    </Routes>
  );
}
