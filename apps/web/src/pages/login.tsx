import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { landingFor } from '../lib/routes';
import { AuthLayout } from '../components/layout/auth-layout';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/form';
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
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in with your work account."
      footer="Forgot your password? Ask HR to reset it for you."
    >
      <Card className="p-5 sm:p-6">
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
    </AuthLayout>
  );
}
