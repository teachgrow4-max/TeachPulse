import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { formatWorkDate } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge } from '../components/ui/badge';
import { buttonClass } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  BuildingIcon,
  CalendarIcon,
  IdCardIcon,
  KeyIcon,
  MailIcon,
  PhoneIcon,
  QrIcon,
  type AppIcon,
} from '../components/ui/icons';
import { Avatar } from '../components/ui/misc';
import { PageContainer, PageHeader } from '../components/ui/page';

const ROLE_LABEL = {
  employee: 'Employee',
  admin: 'Administrator',
  attendance_operator: 'Attendance operator',
  office_display: 'Office display',
} as const;

function Detail({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: AppIcon;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3 bg-surface px-4 py-3.5', className)}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
        <Icon className="h-[1.1rem] w-[1.1rem]" />
      </span>
      <div className="min-w-0">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className="truncate text-sm font-medium">{children}</dd>
      </div>
    </div>
  );
}

/** The signed-in person's profile. */
export function ProfilePage() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <PageContainer width="md">
      <PageHeader title="My Profile" description="Your details, as the office has them." />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <div className="bg-brand-gradient h-24 sm:h-28" aria-hidden="true" />
          <div className="px-5 pb-6 sm:px-6">
            <Avatar
              name={user.fullName}
              src={user.avatarUrl}
              size="xl"
              className="-mt-10 h-20 w-20 text-2xl ring-4 ring-surface"
            />
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate text-xl font-semibold tracking-tight">{user.fullName}</h2>
                <p className="mt-0.5 font-mono text-sm text-muted">{user.employeeCode}</p>
              </div>
              <Badge tone="brand">{ROLE_LABEL[user.role]}</Badge>
            </div>

            <dl className="mt-5 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
              <Detail icon={MailIcon} label="Email">
                {user.email}
              </Detail>
              <Detail icon={PhoneIcon} label="Phone">
                {user.phone ?? '—'}
              </Detail>
              <Detail icon={BuildingIcon} label="Department">
                {user.department?.name ?? '—'}
              </Detail>
              <Detail icon={IdCardIcon} label="Designation">
                {user.designation ?? '—'}
              </Detail>
              <Detail icon={CalendarIcon} label="Joined" className="sm:col-span-2">
                {formatWorkDate(user.joiningDate)}
              </Detail>
            </dl>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          {user.role === 'employee' || user.attendanceRequired ? (
            <Card>
              <CardHeader>
                <CardTitle>Attendance</CardTitle>
                <CardDescription>
                  Your attendance is recorded by an administrator scanning a QR code that you
                  generate each time, on this device, once you are at the office.
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-3">
                <Link to="/attendance-qr" className={buttonClass({ variant: 'primary' })}>
                  <QrIcon className="h-5 w-5" /> Open Attendance QR
                </Link>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Password</CardTitle>
              <CardDescription>Choose a new password for your account.</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              <Link to="/change-password" className={buttonClass({ variant: 'outline' })}>
                <KeyIcon className="h-4 w-4" /> Change password
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
