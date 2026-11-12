import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@teachgrow/shared';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { homeFor } from '../lib/routes';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Field, Input } from '../components/ui/form';
import { Notice } from '../components/ui/misc';

/** Everyone who signs in with a temporary password has to choose their own before anything else. */
export function ChangePasswordPage() {
  const { user, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const policy = passwordSchema.safeParse(next);
  const newProblem = next && !policy.success ? (policy.error.issues[0]?.message ?? null) : null;
  const mismatch = again && again !== next ? 'The two passwords do not match.' : null;
  const canSubmit = current && policy.success && again === next && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !user) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      navigate(homeFor(user.role), { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
          ? 'Your current password is not right.'
          : caught instanceof Error
            ? caught.message
            : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-bold">Choose a new password</h1>
        <p className="mb-5 text-sm text-muted">
          {user?.mustChangePassword
            ? 'You signed in with a temporary password. Choose your own to continue.'
            : 'Choose a new password for your account.'}
        </p>
        <Card className="p-5">
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
            {error ? <Notice tone="danger">{error}</Notice> : null}
            <Field label="Current password">
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                />
              )}
            </Field>
            <Field
              label="New password"
              hint={`At least ${PASSWORD_MIN_LENGTH} characters, with a lowercase letter, a capital and a digit.`}
              error={newProblem}
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                />
              )}
            </Field>
            <Field label="New password again" error={mismatch}>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={again}
                  onChange={(event) => setAgain(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" size="lg" loading={busy} disabled={!canSubmit}>
              Save new password
            </Button>
          </form>
        </Card>
        <div className="mt-4 text-center">
          <button
            type="button"
            className="text-sm text-muted underline underline-offset-4"
            onClick={() => void logout()}
          >
            Sign out instead
          </button>
        </div>
      </div>
    </main>
  );
}
