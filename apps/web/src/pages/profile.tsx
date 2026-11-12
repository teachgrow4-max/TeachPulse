import { useQuery } from '@tanstack/react-query';
import type { EmployeeQrDto } from '@teachgrow/shared';
import { api, messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatWorkDate } from '../lib/format';
import { EmployeeQrView } from '../components/qr/employee-qr-view';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Avatar, Notice, Skeleton } from '../components/ui/misc';

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

/** The signed-in person's profile, with their personal QR code and the ID-card downloads. */
export function ProfilePage() {
  const { user } = useAuth();
  const qr = useQuery({
    queryKey: ['employee-qr', 'me'],
    queryFn: () => api<EmployeeQrDto>('/api/employee-qr/me'),
  });
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

      <Card>
        <CardHeader>
          <CardTitle>My QR code</CardTitle>
          <CardDescription>
            Your personal ID code. An attendance operator scans it to record your attendance.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-3">
          {qr.isLoading ? (
            <div className="flex flex-col items-center gap-3">
              <Skeleton className="aspect-square w-full max-w-[19rem] rounded-2xl" />
              <Skeleton className="h-5 w-40" />
            </div>
          ) : qr.isError ? (
            <Notice tone="danger" title="Your QR code could not be loaded">
              <p>{messageOf(qr.error)}</p>
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                onClick={() => void qr.refetch()}
              >
                Try again
              </Button>
            </Notice>
          ) : qr.data ? (
            <EmployeeQrView qr={qr.data} own />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
