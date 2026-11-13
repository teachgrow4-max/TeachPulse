import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScanLogDto, ScanRecorded } from '@teachgrow/shared';
import { ApiError, api, messageOf } from '../lib/api';
import { buzz, describeDevice, isTouchDevice } from '../lib/device';
import { formatTime } from '../lib/format';
import { CameraView } from '../components/scanner/camera-view';
import { RecentScans, RejectionPanel, SuccessPanel } from '../components/scanner/scan-panels';
import { decodePhoto, useCameraScanner } from '../components/scanner/use-camera-scanner';
import { Card } from '../components/ui/card';
import { ClockIcon, QrIcon, ScanIcon, ShieldCheckIcon, type AppIcon } from '../components/ui/icons';
import { Notice } from '../components/ui/misc';
import { PageContainer, PageHeader } from '../components/ui/page';
import { useToast } from '../components/ui/toast';

/**
 * The QR attendance scanner for administrators and attendance operators.
 *
 *   point the camera at the code on an employee's screen
 *     -> the server validates it and records the attendance, in one step
 *     -> the employee, the time and their status are shown
 *
 * There is no location or Wi-Fi check for the person scanning: they can be anywhere. The proof
 * that the employee is at the office was made on the employee's own device when they generated the
 * code, and the code is short lived and works once. A repeat scan records nothing twice.
 */

type Phase =
  | { name: 'scanning' }
  | { name: 'recording' }
  | { name: 'rejected'; error: ApiError }
  | { name: 'done'; result: ScanRecorded };

const RECENT_KEY = ['qr-attendance', 'recent'] as const;

const STEPS: Array<{ icon: AppIcon; title: string; text: string }> = [
  {
    icon: ShieldCheckIcon,
    title: 'The employee verifies',
    text: 'At the office, in their own app, they generate a code.',
  },
  {
    icon: ScanIcon,
    title: 'You scan it',
    text: 'Hold the camera to their screen, from anywhere.',
  },
  {
    icon: ClockIcon,
    title: 'Attendance is recorded',
    text: 'It happens straight away and works only once.',
  },
];

export function ScannerPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ name: 'scanning' });
  const busy = useRef(false);
  /** The last code that was sent, so a lost connection can send it again without a new scan. */
  const lastCode = useRef<string | null>(null);

  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => api<{ items: ScanLogDto[] }>('/api/qr-attendance/recent?limit=8'),
    select: (data) => data.items,
  });
  const refreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
    void queryClient.invalidateQueries({ queryKey: ['attendance-daily'] });
    void queryClient.invalidateQueries({ queryKey: ['qr-overview'] });
  }, [queryClient]);

  const cameraRef = useRef<ReturnType<typeof useCameraScanner> | null>(null);

  const record = useCallback(
    async (text: string) => {
      if (busy.current) return;
      busy.current = true;
      lastCode.current = text;
      setPhase({ name: 'recording' });
      const cameras = cameraRef.current;
      const cameraLabel = cameras?.cameras.find((c) => c.id === cameras.cameraId)?.label;
      try {
        const result = await api<ScanRecorded>('/api/qr-attendance/scan', {
          method: 'POST',
          body: {
            payload: text,
            scanner: {
              kind: isTouchDevice() ? 'MOBILE' : 'WEB',
              label: describeDevice(),
              ...(cameraLabel ? { camera: cameraLabel.slice(0, 120) } : {}),
            },
          },
        });
        buzz([30, 40, 90]);
        toast.show({
          tone: 'success',
          title: `${result.employee.fullName} ${result.action === 'CHECK_IN' ? 'checked in' : 'checked out'}`,
          text: `Recorded at ${formatTime(result.recordedAt)}`,
        });
        setPhase({ name: 'done', result });
      } catch (error) {
        buzz([80, 60, 80]);
        const refused =
          error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', messageOf(error));
        if (refused.code === 'NETWORK_ERROR') {
          toast.show({
            tone: 'warning',
            title: 'Connection problem',
            text: 'Nothing was recorded. Check your connection and try again.',
          });
        }
        setPhase({ name: 'rejected', error: refused });
      } finally {
        busy.current = false;
        refreshRecent();
      }
    },
    [refreshRecent, toast],
  );

  const onDecode = useCallback(
    (text: string) => {
      if (phase.name === 'scanning') void record(text);
    },
    [phase.name, record],
  );

  const camera = useCameraScanner({ enabled: phase.name === 'scanning', onDecode });
  cameraRef.current = camera;

  const onPhoto = useCallback(
    async (file: File) => {
      try {
        onDecode(await decodePhoto(file));
      } catch {
        setPhase({
          name: 'rejected',
          error: new ApiError(
            0,
            'EMPLOYEE_QR_INVALID',
            'No QR code could be read from that photo. Try a sharper, closer photo.',
          ),
        });
      }
    },
    [onDecode],
  );

  const scanAnother = () => setPhase({ name: 'scanning' });
  const retry = () => {
    if (lastCode.current) void record(lastCode.current);
  };

  return (
    <PageContainer>
      <PageHeader
        title="QR Attendance"
        description="Scan an employee’s QR code to record their attendance. You can do this from anywhere: your own location and Wi-Fi are never checked."
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="mx-auto w-full min-w-0 max-w-2xl lg:max-w-none">
          {phase.name === 'scanning' || phase.name === 'recording' ? (
            <CameraView
              camera={camera}
              busy={phase.name === 'recording'}
              onPhoto={(file) => void onPhoto(file)}
              caption="Hold the QR code inside the frame. The employee generates it in their TeachGrow app."
            />
          ) : null}

          {phase.name === 'rejected' ? (
            <RejectionPanel error={phase.error} onNext={scanAnother} onRetry={retry} />
          ) : null}

          {phase.name === 'done' ? (
            <SuccessPanel result={phase.result} onNext={scanAnother} />
          ) : null}

          <Card className="mt-6 p-5">
            <h2 className="text-sm font-semibold">How it works</h2>
            <ol className="mt-4 flex flex-col gap-4">
              {STEPS.map(({ icon: Icon, title, text }, index) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Icon className="h-[1.1rem] w-[1.1rem]" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight">
                      <span className="mr-1 text-muted tabular-nums">{index + 1}.</span>
                      {title}
                    </p>
                    <p className="mt-0.5 text-sm text-muted">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="min-w-0 space-y-4">
          <RecentScans items={recent.data} loading={recent.isLoading} />
          {recent.isError ? (
            <Notice tone="warning">Recent scans could not be loaded.</Notice>
          ) : null}
          <Card className="flex items-start gap-3 p-4 text-sm text-muted">
            <QrIcon className="mt-0.5 h-5 w-5 text-brand" />
            <p>
              A QR code works once and only for a minute or two. If a scan says a code has expired
              or was already used, ask the employee to generate a new one.
            </p>
          </Card>
        </aside>
      </div>
    </PageContainer>
  );
}
