import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { landingFor } from '../lib/routes';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/form';
import { QrIcon } from '../components/ui/icons';
import { Notice } from '../components/ui/misc';

function friendly(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_CREDENTIALS':
        return 'That email or password is not right.';
      case 'ACCOUNT_LOCKED':
        return 'Too many attempts. Please wait a few minutes before trying again.';
      case 'ACCOUNT_DEACTIVATED':
        return 'This account has been deactivated. Please contact HR.';
      case 'CSRF_REJECTED':
        return 'This page is not allowed to sign in from this address. Open the app from its official address.';
      case 'RATE_LIMITED':
        return 'Too many requests. Please wait a moment and try again.';
      default:
        return error.message;
    }
  }
  return 'Something went wrong. Please try again.';
}

export function LoginPage() {
  const { status, user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'signedIn' && user) {
    return <Navigate to={landingFor(user.role, location.state?.from)} replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const signedIn = await login(email.trim(), password);
      navigate(landingFor(signedIn.role, location.state?.from), { replace: true });
    } catch (caught) {
      setError(friendly(caught));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-brand-fg shadow-card">
            <QrIcon className="h-8 w-8" />
          </span>
          <div>
            <h1 className="text-2xl font-bold">TeachGrow Attendance</h1>
            <p className="text-sm text-muted">Sign in with your work account</p>
          </div>
        </div>
        <Card className="p-5">
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Field label="Email">
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoCapitalize="none"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
            <Field label="Password">
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
              Sign in
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-muted">
          Forgot your password? Ask HR to reset it for you.
        </p>
      </div>
    </main>
  );
}
