import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { formatWorkDate } from '../lib/format';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { QrIcon } from '../components/ui/icons';
import { Avatar } from '../components/ui/misc';

const ROLE_LABEL = {
  employee: 'Employee',
  admin: 'Administrator',
  attendance_operator: 'Attendance operator',
  office_display: 'Office display',
} as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

/** The signed-in person's profile. */
export function ProfilePage() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader className="flex-row items-center gap-4">
          <Avatar name={user.fullName} src={user.avatarUrl} className="h-20 w-20 text-2xl" />
          <div className="min-w-0">
            <CardTitle className="truncate text-xl">{user.fullName}</CardTitle>
            <CardDescription className="font-mono">{user.employeeCode}</CardDescription>
            <Badge tone="brand" className="mt-2">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-line">
            <Row label="Email">{user.email}</Row>
            <Row label="Department">{user.department?.name ?? '—'}</Row>
            <Row label="Designation">{user.designation ?? '—'}</Row>
            <Row label="Joined">{formatWorkDate(user.joiningDate)}</Row>
            <Row label="Phone">{user.phone ?? '—'}</Row>
          </dl>
        </CardContent>
      </Card>

      {user.role === 'employee' || user.attendanceRequired ? (
        <Card>
          <CardHeader>
            <CardTitle>Attendance</CardTitle>
            <CardDescription>
              Your attendance is recorded by an administrator scanning a QR code that you generate
              each time, on this device, once you are at the office.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-3">
            <Link
              to="/attendance-qr"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg hover:opacity-90"
            >
              <QrIcon className="h-5 w-5" /> Open Attendance QR
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
