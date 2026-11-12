import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScanLogDto, ScanRecorded } from '@teachgrow/shared';
import { ApiError, api, messageOf } from '../lib/api';
import { buzz, describeDevice, isTouchDevice } from '../lib/device';
import { CameraView } from '../components/scanner/camera-view';
import { RecentScans, RejectionPanel, SuccessPanel } from '../components/scanner/scan-panels';
import { decodePhoto, useCameraScanner } from '../components/scanner/use-camera-scanner';
import { Notice } from '../components/ui/misc';
import { SpinnerIcon } from '../components/ui/icons';

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

export function ScannerPage() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ name: 'scanning' });
  const busy = useRef(false);

  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => api<{ items: ScanLogDto[] }>('/api/qr-attendance/recent?limit=8'),
    select: (data) => data.items,
  });
  const refreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: RECENT_KEY });
    void queryClient.invalidateQueries({ queryKey: ['attendance-daily'] });
  }, [queryClient]);

  const cameraRef = useRef<ReturnType<typeof useCameraScanner> | null>(null);

  const record = useCallback(
    async (text: string) => {
      if (busy.current) return;
      busy.current = true;
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
        setPhase({ name: 'done', result });
      } catch (error) {
        buzz([80, 60, 80]);
        setPhase({
          name: 'rejected',
          error: error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', messageOf(error)),
        });
      } finally {
        busy.current = false;
        refreshRecent();
      }
    },
    [refreshRecent],
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

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <h1 className="mb-1 text-2xl font-bold">Scan employee QR</h1>
        <p className="mb-4 text-sm text-muted">
          Hold the camera to the QR code on an employee’s screen. Their attendance is recorded
          straight away. You can do this from anywhere.
        </p>

        {phase.name === 'scanning' || phase.name === 'recording' ? (
          <div className="relative">
            <CameraView
              camera={camera}
              onPhoto={(file) => void onPhoto(file)}
              caption="Hold the QR code inside the frame. The employee generates it in their TeachGrow app."
            />
            {phase.name === 'recording' ? (
              <div
                role="status"
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-3xl bg-stage/70 text-white backdrop-blur-[2px]"
              >
                <SpinnerIcon className="h-9 w-9" />
                <p className="text-sm font-semibold">Recording attendance…</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase.name === 'rejected' ? (
          <div className="mx-auto max-w-xl py-6">
            <RejectionPanel error={phase.error} onNext={scanAnother} />
          </div>
        ) : null}

        {phase.name === 'done' ? (
          <div className="mx-auto max-w-xl py-6">
            <SuccessPanel result={phase.result} onNext={scanAnother} />
          </div>
        ) : null}
      </div>

      <aside className="min-w-0">
        <RecentScans items={recent.data} loading={recent.isLoading} />
        {recent.isError ? (
          <Notice tone="warning" className="mt-3">
            Recent scans could not be loaded.
          </Notice>
        ) : null}
        <p className="mt-4 text-xs text-muted">
          A QR code works once and only for a minute or two. If a scan says a code has expired or
          was already used, ask the employee to generate a new one.
        </p>
      </aside>
    </div>
  );
}
