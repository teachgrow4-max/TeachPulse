import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  looksLikeEmployeeQr,
  type ConfirmScanResponse,
  type ScanLogDto,
  type ScanResolution,
  type VerificationReasonDto,
} from '@teachgrow/shared';
import { ApiError, api, messageOf } from '../lib/api';
import { buzz, describeDevice, isTouchDevice, newIdempotencyKey } from '../lib/device';
import { getLocationFix, LocationError } from '../lib/geo';
import { CameraView } from '../components/scanner/camera-view';
import {
  ActionPanel,
  EmployeeIdCard,
  RecentScans,
  RejectionPanel,
  SuccessPanel,
  type SubmitFailure,
  type SubmitStep,
} from '../components/scanner/scan-panels';
import { decodePhoto, useCameraScanner } from '../components/scanner/use-camera-scanner';
import { Notice } from '../components/ui/misc';
import { SpinnerIcon } from '../components/ui/icons';

/**
 * The QR attendance scanner for administrators and attendance operators.
 *
 *   point the camera at an employee's code
 *     -> the employee appears with what will happen (check in / check out / nothing to do)
 *     -> the operator confirms (nothing is ever recorded by scanning alone)
 *     -> their own location is checked against the office, and the server records the attendance
 *
 * A mistake costs nothing: nothing is recorded until the operator presses the big button, and a
 * confirmation that is repeated (a double tap, a dropped connection) is recorded only once.
 */

type Phase =
  | { name: 'scanning' }
  | { name: 'resolving' }
  | { name: 'rejected'; error: ApiError }
  | { name: 'resolved'; scan: ScanResolution; key: string }
  | { name: 'officeCode'; scan: ScanResolution; key: string }
  | { name: 'done'; result: ConfirmScanResponse };

interface VerificationFailureDetails {
  reasons?: VerificationReasonDto[];
}

const RECENT_KEY = ['qr-attendance', 'recent'] as const;

/** Errors after which the office check has to be done again. */
const REVERIFY = new Set([
  'VERIFICATION_FAILED',
  'VERIFICATION_REQUIRED',
  'VERIFICATION_INVALID',
  'VERIFICATION_EXPIRED',
  'VERIFICATION_USED',
]);

/** Errors where pressing the same button again cannot help: the scan itself is out of date. */
const NOT_WORTH_RETRYING = new Set([
  'SCAN_EXPIRED',
  'SCAN_ALREADY_RECORDED',
  'SCAN_NOT_ACTIONABLE',
  'SCAN_ACTION_MISMATCH',
  'SELF_SCAN_FORBIDDEN',
  'EMPLOYEE_QR_REVOKED',
  'EMPLOYEE_INACTIVE',
  'ATTENDANCE_NOT_TRACKED',
  'ALREADY_CHECKED_IN',
  'ALREADY_CHECKED_OUT',
  'NOT_CHECKED_IN',
  'HOLIDAY',
  'WEEKLY_OFF',
  'ON_LEAVE',
  'ACTIVE_BREAK',
  'NOT_FOUND',
  'FORBIDDEN',
  'IDEMPOTENCY_KEY_REUSED',
]);

/** Seconds left until `iso`, ticking once a second. */
function useSecondsLeft(iso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : 0;
}

export function ScannerPage() {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ name: 'scanning' });
  const [step, setStep] = useState<SubmitStep>('idle');
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const busy = useRef(false);
  /** The lobby code, once scanned, when the policy asks the operator to prove they are in the building. */
  const officeCode = useRef<string | null>(null);
  /**
   * The scan whose office check has already passed. After a dropped connection, pressing the
   * button again goes straight to recording (with the same key) instead of asking for a second
   * location check: the first attempt may well have been recorded already.
   */
  const verifiedScan = useRef<string | null>(null);

  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => api<{ items: ScanLogDto[] }>('/api/qr-attendance/recent?limit=8'),
    select: (data) => data.items,
  });
  const refreshRecent = useCallback(
    () => queryClient.invalidateQueries({ queryKey: RECENT_KEY }),
    [queryClient],
  );

  const scannerInfo = useCallback(
    (cameraLabel?: string) => ({
      kind: isTouchDevice() ? ('MOBILE' as const) : ('WEB' as const),
      label: describeDevice(),
      ...(cameraLabel ? { camera: cameraLabel.slice(0, 120) } : {}),
    }),
    [],
  );

  // ---- reading a code --------------------------------------------------------------------

  const cameraRef = useRef<ReturnType<typeof useCameraScanner> | null>(null);

  const resolve = useCallback(
    async (text: string) => {
      if (busy.current) return;
      busy.current = true;
      setFailure(null);
      setStep('idle');
      setPhase({ name: 'resolving' });
      const cameraLabel = cameraRef.current?.cameras.find(
        (c) => c.id === cameraRef.current?.cameraId,
      )?.label;
      try {
        const scan = await api<ScanResolution>('/api/qr-attendance/scan', {
          method: 'POST',
          body: { payload: text, scanner: scannerInfo(cameraLabel) },
        });
        buzz(40);
        setPhase({ name: 'resolved', scan, key: newIdempotencyKey() });
      } catch (error) {
        buzz([80, 60, 80]);
        setPhase({
          name: 'rejected',
          error: error instanceof ApiError ? error : new ApiError(0, 'UNKNOWN', messageOf(error)),
        });
      } finally {
        busy.current = false;
        void refreshRecent();
      }
    },
    [refreshRecent, scannerInfo],
  );

  const onDecode = useCallback(
    (text: string) => {
      if (phase.name === 'scanning') void resolve(text);
      else if (phase.name === 'officeCode') {
        // The operator is being asked for the lobby screen's code, not an employee's.
        if (looksLikeEmployeeQr(text)) return;
        officeCode.current = text;
        setPhase((current) =>
          current.name === 'officeCode'
            ? { name: 'resolved', scan: current.scan, key: current.key }
            : current,
        );
        void confirmWith(text);
      }
    },
    // confirmWith is declared below; it is re-created each render and reads the phase it was made with.
    [phase, resolve],
  );

  const cameraWanted = phase.name === 'scanning' || phase.name === 'officeCode';
  const camera = useCameraScanner({ enabled: cameraWanted, onDecode });
  useEffect(() => {
    cameraRef.current = camera;
  });

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

  // ---- confirming ------------------------------------------------------------------------

  const resolvedScan = phase.name === 'resolved' || phase.name === 'officeCode' ? phase.scan : null;
  const secondsLeft = useSecondsLeft(resolvedScan?.expiresAt ?? null);

  const fail = useCallback((title: string, error: unknown, canRetry = true) => {
    const details =
      error instanceof ApiError
        ? (error.details as VerificationFailureDetails | undefined)
        : undefined;
    const reasons = details?.reasons?.map((r) => ({ message: r.message, hint: r.hint }));
    setFailure({
      title,
      // When each reason is listed below with what to do about it, the headline need not repeat them.
      message: reasons && reasons.length > 0 ? 'The office check did not pass:' : messageOf(error),
      reasons,
      canRetry,
    });
    setStep('idle');
    buzz([80, 60, 80]);
  }, []);

  async function confirmWith(lobbyCode: string | null) {
    if (phase.name !== 'resolved' && phase.name !== 'officeCode') return;
    const { scan, key } = phase;
    if (busy.current || (scan.action !== 'CHECK_IN' && scan.action !== 'CHECK_OUT')) return;
    busy.current = true;
    setFailure(null);
    try {
      if (verifiedScan.current !== scan.scanId) {
        // 1. where is the operator?
        setStep('location');
        const fix = await getLocationFix();

        // 2. prove they are at the office
        setStep('verifying');
        await api(`/api/qr-attendance/scans/${scan.scanId}/verify`, {
          method: 'POST',
          body: {
            channel: isTouchDevice() ? 'MOBILE' : 'WEB',
            gps: fix,
            ...(lobbyCode ? { qr: { payload: lobbyCode } } : {}),
          },
        });
        verifiedScan.current = scan.scanId;
      }

      // 3. record it. The key makes a repeat of THIS confirmation harmless.
      setStep('recording');
      const result = await api<ConfirmScanResponse>(
        `/api/qr-attendance/scans/${scan.scanId}/confirm`,
        {
          method: 'POST',
          body: { action: scan.action },
          idempotencyKey: key,
        },
      );
      buzz([30, 40, 90]);
      setStep('idle');
      setPhase({ name: 'done', result });
      void refreshRecent();
    } catch (error) {
      if (error instanceof ApiError && REVERIFY.has(error.code)) {
        // The office check no longer counts; the next press starts it again.
        verifiedScan.current = null;
        officeCode.current = null;
      }
      if (error instanceof LocationError) {
        fail('Your location is needed', error);
      } else if (error instanceof ApiError && error.code === 'VERIFICATION_FAILED') {
        fail('You do not appear to be at the office', error);
      } else if (error instanceof ApiError && error.isNetwork) {
        fail(
          'Connection lost',
          new ApiError(
            0,
            'NETWORK_ERROR',
            'Could not reach the server. If the attendance was recorded you will see it in recent scans; pressing the button again is safe and will not record it twice.',
          ),
        );
      } else if (error instanceof ApiError && NOT_WORTH_RETRYING.has(error.code)) {
        // The situation itself has changed (already checked in, code revoked ...): scan afresh.
        fail('Attendance was not recorded', error, false);
      } else {
        fail('Attendance was not recorded', error);
      }
      void refreshRecent();
    } finally {
      busy.current = false;
    }
  }

  function onConfirm() {
    if (phase.name !== 'resolved') return;
    const needsOfficeCode = phase.scan.requiredLayers.includes('QR') && !officeCode.current;
    if (needsOfficeCode) {
      setFailure(null);
      setPhase({ name: 'officeCode', scan: phase.scan, key: phase.key });
      return;
    }
    void confirmWith(officeCode.current);
  }

  function scanAnother() {
    officeCode.current = null;
    verifiedScan.current = null;
    setFailure(null);
    setStep('idle');
    setPhase({ name: 'scanning' });
  }

  // A device that cannot present a registered-device proof cannot satisfy a policy that asks for it.
  const deviceRequired = resolvedScan?.requiredLayers.includes('DEVICE') ?? false;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <h1 className="mb-1 text-2xl font-bold">QR attendance</h1>
        <p className="mb-4 text-sm text-muted">
          Scan an employee’s QR code, check who it is, then confirm to record their attendance.
        </p>

        {phase.name === 'scanning' || phase.name === 'resolving' || phase.name === 'officeCode' ? (
          <div className="relative">
            {phase.name === 'officeCode' ? (
              <Notice tone="info" title="Scan the code on the office screen" className="mb-3">
                This office also asks you to prove you are in the building. Hold the camera up to
                the rotating QR code on the lobby screen.
              </Notice>
            ) : null}
            <CameraView
              camera={camera}
              onPhoto={(file) => void onPhoto(file)}
              caption={
                phase.name === 'officeCode'
                  ? 'Waiting for the office screen code…'
                  : 'Hold the QR code inside the frame. Printed ID cards and phone screens both work.'
              }
            />
            {phase.name === 'resolving' ? (
              <div
                role="status"
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-3xl bg-stage/70 text-white backdrop-blur-[2px]"
              >
                <SpinnerIcon className="h-9 w-9" />
                <p className="text-sm font-semibold">Looking up the employee…</p>
              </div>
            ) : null}
            {phase.name === 'officeCode' ? (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  className="text-sm font-medium text-muted underline underline-offset-4"
                  onClick={() => setPhase({ name: 'resolved', scan: phase.scan, key: phase.key })}
                >
                  Back to the employee
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase.name === 'resolved' ? (
          <div className="mx-auto flex max-w-xl flex-col gap-4">
            <div className="pop-in">
              <EmployeeIdCard scan={phase.scan} />
            </div>
            <ActionPanel
              scan={phase.scan}
              secondsLeft={secondsLeft}
              step={step}
              failure={failure}
              blockedNotice={
                deviceRequired
                  ? 'This office also asks scanners to prove a registered device. That is not available in the web app yet; ask an administrator to adjust the setting or use the mobile app.'
                  : null
              }
              onConfirm={onConfirm}
              onCancel={scanAnother}
            />
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
          Confirming also checks that <strong>you</strong> are at the office (your location and the
          office network), so attendance cannot be recorded from somewhere else.
        </p>
      </aside>
    </div>
  );
}
