import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DailyQrIssued,
  DailyQrProgress,
  DailyQrToday,
  DailyQrVerified,
  VerificationReasonDto,
} from '@teachgrow/shared';
import { ApiError, api, messageOf } from '../lib/api';
import { buzz } from '../lib/device';
import { formatTime, formatWorkDate, countdown } from '../lib/format';
import { getLocationFix, LocationError } from '../lib/geo';
import { useSecondsLeft } from '../lib/hooks';
import { cn } from '../lib/utils';
import { QrImage } from '../components/qr/qr-image';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  QrIcon,
  ShieldCheckIcon,
  SpinnerIcon,
} from '../components/ui/icons';
import { Notice, Skeleton } from '../components/ui/misc';

/**
 * An employee's own attendance QR code.
 *
 *   1. check the location and the office network   (the server decides; nothing here is trusted)
 *   2. generate a code for today's next action      (check in, or check out)
 *   3. show it to an administrator, who scans it    (the code is short lived and works once)
 *
 * Administrators are not asked for a location or a network; they generate straight away.
 */

const TODAY_KEY = ['attendance-qr', 'today'] as const;

type Check =
  | { name: 'idle' }
  | { name: 'working'; text: string }
  | { name: 'passed'; result: DailyQrVerified }
  | {
      name: 'failed';
      title: string;
      message: string;
      layers?: Record<string, string>;
      reasons: VerificationReasonDto[];
    };

type LayerState = 'idle' | 'working' | 'pass' | 'fail';

function layerState(check: Check, layer: 'GPS' | 'NETWORK'): LayerState {
  if (check.name === 'working') return 'working';
  if (check.name === 'passed') return 'pass';
  if (check.name === 'failed') {
    // A location that could not be read never reached the server, so no layer was judged.
    if (!check.layers) return layer === 'GPS' ? 'fail' : 'idle';
    return check.layers[layer] === 'FAIL'
      ? 'fail'
      : check.layers[layer] === 'PASS'
        ? 'pass'
        : 'idle';
  }
  return 'idle';
}

function StatusRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: LayerState;
  detail?: string;
}) {
  const tone =
    state === 'pass'
      ? 'bg-success-soft text-success'
      : state === 'fail'
        ? 'bg-danger-soft text-danger'
        : 'bg-surface-2 text-muted';
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', tone)}
      >
        {state === 'working' ? (
          <SpinnerIcon className="h-5 w-5" />
        ) : state === 'pass' ? (
          <CheckIcon className="h-5 w-5" />
        ) : state === 'fail' ? (
          <AlertIcon className="h-5 w-5" />
        ) : (
          <ShieldCheckIcon className="h-5 w-5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted">
          {detail ??
            (state === 'pass'
              ? 'Verified'
              : state === 'fail'
                ? 'Not verified'
                : state === 'working'
                  ? 'Checking…'
                  : 'Not checked yet')}
        </p>
      </div>
      <Badge tone={state === 'pass' ? 'success' : state === 'fail' ? 'danger' : 'neutral'}>
        {state === 'pass'
          ? 'OK'
          : state === 'fail'
            ? 'Failed'
            : state === 'working'
              ? '…'
              : 'Pending'}
      </Badge>
    </li>
  );
}

export function AttendanceQrPage() {
  const queryClient = useQueryClient();
  const today = useQuery({
    queryKey: TODAY_KEY,
    queryFn: () => api<DailyQrToday>('/api/attendance-qr/today'),
  });
  const [check, setCheck] = useState<Check>({ name: 'idle' });
  const [issued, setIssued] = useState<DailyQrIssued | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const info = today.data;
  const verificationRequired = info?.verificationRequired ?? true;
  const verifiedUntil = check.name === 'passed' ? check.result.expiresAt : null;
  const proofSecondsLeft = useSecondsLeft(verifiedUntil);
  const codeSecondsLeft = useSecondsLeft(issued?.expiresAt ?? null);

  // ---- has the administrator scanned it yet? -------------------------------------------------
  const progress = useQuery({
    queryKey: ['attendance-qr', 'progress', issued?.id],
    queryFn: () => api<DailyQrProgress>(`/api/attendance-qr/${issued!.id}`),
    enabled: issued !== null,
    // Poll while the code can still be scanned; stop once it has been used or has run out.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'USED' || status === 'EXPIRED' || status === 'SUPERSEDED' ? false : 3000;
    },
  });
  const used = progress.data?.status === 'USED';
  useEffect(() => {
    if (used) {
      buzz([30, 40, 90]);
      void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
    }
  }, [used, queryClient]);

  const expired = issued !== null && !used && codeSecondsLeft <= 0;

  // ---- 1. the office check ------------------------------------------------------------------
  const runCheck = async () => {
    setGenerateError(null);
    setCheck({ name: 'working', text: 'Finding your location…' });
    try {
      const fix = await getLocationFix();
      setCheck({ name: 'working', text: 'Checking the office network…' });
      const result = await api<DailyQrVerified>('/api/attendance-qr/verify', {
        method: 'POST',
        body: { gps: fix },
      });
      setCheck({ name: 'passed', result });
    } catch (error) {
      buzz([80, 60, 80]);
      if (error instanceof LocationError) {
        setCheck({
          name: 'failed',
          title: 'Your location is needed',
          message: error.message,
          reasons: [],
        });
      } else if (error instanceof ApiError && error.code === 'VERIFICATION_FAILED') {
        const details = error.details as
          { layers?: Record<string, string>; reasons?: VerificationReasonDto[] } | undefined;
        setCheck({
          name: 'failed',
          title: 'You are not verified at the office',
          message: 'These checks did not pass:',
          layers: details?.layers,
          reasons: details?.reasons ?? [],
        });
      } else {
        setCheck({
          name: 'failed',
          title: 'Could not check',
          message: messageOf(error),
          reasons: [],
        });
        void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
      }
    }
  };

  // ---- 2. generating ------------------------------------------------------------------------
  const generate = useMutation({
    mutationFn: () =>
      api<DailyQrIssued>('/api/attendance-qr/generate', {
        method: 'POST',
        body: check.name === 'passed' ? { verificationId: check.result.verificationId } : {},
      }),
    onSuccess: (made) => {
      setGenerateError(null);
      setIssued(made);
      // The proof was spent. Another code needs a fresh check.
      setCheck({ name: 'idle' });
      void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
    },
    onError: (error) => {
      setGenerateError(messageOf(error));
      if (error instanceof ApiError && error.code.startsWith('VERIFICATION_')) {
        setCheck({ name: 'idle' });
      }
      void queryClient.invalidateQueries({ queryKey: TODAY_KEY });
    },
  });

  const canGenerate =
    info !== undefined &&
    (info.next === 'CHECK_IN' || info.next === 'CHECK_OUT') &&
    info.generatedToday < info.maxPerDay &&
    (!verificationRequired || (check.name === 'passed' && proofSecondsLeft > 0));
  const checking = check.name === 'working';
  const proofLapsed = check.name === 'passed' && proofSecondsLeft <= 0;
  const action = info?.next === 'CHECK_OUT' ? 'check-out' : 'check-in';

  if (today.isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-5">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="mt-6 h-72 w-full rounded-2xl" />
      </div>
    );
  }
  if (today.isError || !info) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-8">
        <Notice tone="danger" title="Attendance QR is not available">
          <p>{messageOf(today.error)}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => void today.refetch()}>
            Try again
          </Button>
        </Notice>
      </div>
    );
  }

  const nothingToDo = info.next === 'ALREADY_CHECKED_OUT' || info.next === 'BLOCKED';

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold">Attendance QR</h1>
        <p className="mb-4 text-sm text-muted">
          {formatWorkDate(info.workDate)} ·{' '}
          {info.attendance.checkInAt
            ? `checked in at ${formatTime(info.attendance.checkInAt)}${
                info.attendance.checkOutAt
                  ? `, out at ${formatTime(info.attendance.checkOutAt)}`
                  : ''
              }`
            : 'not checked in yet'}
        </p>

        {nothingToDo ? (
          <Notice
            tone={info.next === 'ALREADY_CHECKED_OUT' ? 'success' : 'info'}
            title={
              info.next === 'ALREADY_CHECKED_OUT'
                ? 'Your attendance for today is complete'
                : 'No attendance to record today'
            }
          >
            {info.next === 'ALREADY_CHECKED_OUT'
              ? `You checked out at ${formatTime(info.attendance.checkOutAt)}.`
              : (info.blockedReason?.message ?? 'Attendance cannot be recorded right now.')}
          </Notice>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                {verificationRequired ? 'Step 1 · Verify you are at the office' : 'Ready'}
              </CardTitle>
              <CardDescription>
                {verificationRequired
                  ? 'Your location and the office Wi-Fi are checked on the server before a code is made.'
                  : 'Administrators are not asked for their location or Wi-Fi.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {verificationRequired ? (
                <>
                  <ul className="divide-y divide-line">
                    <StatusRow
                      label="Location"
                      state={layerState(check, 'GPS')}
                      detail={
                        check.name === 'passed' && check.result.gps.distanceMeters !== null
                          ? `${check.result.gps.distanceMeters} m from the office`
                          : undefined
                      }
                    />
                    <StatusRow label="Office Wi-Fi" state={layerState(check, 'NETWORK')} />
                  </ul>

                  {check.name === 'failed' ? (
                    <Notice tone="danger" title={check.title} className="shake mt-3">
                      <p>{check.message}</p>
                      {check.reasons.length > 0 ? (
                        <ul className="mt-1.5 list-disc space-y-1 pl-5">
                          {check.reasons.map((reason) => (
                            <li key={reason.code}>
                              {reason.message} <span className="opacity-80">{reason.hint}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </Notice>
                  ) : null}

                  {check.name !== 'passed' || proofLapsed ? (
                    <Button
                      className="mt-4 w-full"
                      size="lg"
                      loading={checking}
                      onClick={() => void runCheck()}
                      disabled={generate.isPending}
                    >
                      {check.name === 'failed' || proofLapsed
                        ? 'Check again'
                        : 'Check my location and Wi-Fi'}
                    </Button>
                  ) : (
                    <p className="mt-3 text-center text-xs text-muted">
                      Verified. Generate your code within{' '}
                      <span className="font-mono font-semibold">{countdown(proofSecondsLeft)}</span>
                      .
                    </p>
                  )}
                  {proofLapsed ? (
                    <p className="mt-2 text-center text-xs text-muted">
                      The check has expired. Run it again.
                    </p>
                  ) : null}
                </>
              ) : null}

              <div className={cn(verificationRequired && 'mt-5 border-t border-line pt-4')}>
                {verificationRequired ? (
                  <p className="mb-2 text-sm font-semibold">Step 2 · Generate your {action} QR</p>
                ) : null}
                <Button
                  size="xl"
                  variant={info.next === 'CHECK_OUT' ? 'warning' : 'success'}
                  className="w-full"
                  loading={generate.isPending}
                  disabled={!canGenerate}
                  onClick={() => generate.mutate()}
                >
                  <QrIcon className="h-6 w-6" /> Generate Attendance QR
                </Button>
                {generateError ? (
                  <Notice tone="danger" className="shake mt-3">
                    {generateError}
                  </Notice>
                ) : null}
                <p className="mt-2 text-center text-xs text-muted">
                  Codes made today: {info.generatedToday} of {info.maxPerDay}. A new code replaces
                  the old one.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="min-w-0 self-start">
        <CardHeader>
          <CardTitle>Your QR code</CardTitle>
          <CardDescription>
            Show it to an administrator. It works once and only until the timer runs out.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-3">
          {issued ? (
            <div className="flex flex-col items-center gap-3">
              <div className="relative w-full max-w-[22rem]">
                <QrImage
                  payload={issued.payload}
                  label={`Attendance QR code for ${issued.action === 'CHECK_IN' ? 'check-in' : 'check-out'}`}
                  className={cn('shadow-card', (used || expired) && 'opacity-15 blur-[1px]')}
                />
                {used ? (
                  <div
                    role="status"
                    className="pop-in absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
                  >
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-success-solid text-on-solid">
                      <CheckIcon className="h-9 w-9" />
                    </span>
                    <p className="text-lg font-extrabold">
                      {issued.action === 'CHECK_IN' ? 'Checked in' : 'Checked out'}
                    </p>
                    <p className="text-sm">Recorded at {formatTime(progress.data?.usedAt)}</p>
                  </div>
                ) : expired ? (
                  <div
                    role="status"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
                  >
                    <p className="text-lg font-extrabold">Expired</p>
                    <p className="text-sm text-muted">Verify again to make a new code.</p>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <Badge tone={issued.action === 'CHECK_IN' ? 'success' : 'warning'}>
                  {issued.action === 'CHECK_IN' ? 'Check-in code' : 'Check-out code'}
                </Badge>
                {used ? (
                  <Badge tone="success">Scanned</Badge>
                ) : expired ? (
                  <Badge tone="danger">Expired</Badge>
                ) : (
                  <Badge tone={codeSecondsLeft <= 15 ? 'warning' : 'info'}>
                    <ClockIcon className="h-3.5 w-3.5" /> Expires in{' '}
                    <span className="font-mono">{countdown(codeSecondsLeft)}</span>
                  </Badge>
                )}
              </div>
              {!used && !expired ? (
                <p className="text-center text-xs text-muted">
                  Waiting for an administrator to scan…
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex aspect-square w-full max-w-[22rem] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-surface-2 text-center text-muted mx-auto">
              <QrIcon className="h-12 w-12 opacity-50" />
              <p className="max-w-[14rem] text-sm">
                {nothingToDo
                  ? 'No code is needed right now.'
                  : verificationRequired
                    ? 'Verify your location and Wi-Fi, then generate your code.'
                    : 'Generate your code when you are ready.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
