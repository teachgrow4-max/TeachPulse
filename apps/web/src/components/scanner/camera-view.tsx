import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  CameraIcon,
  CameraOffIcon,
  ImageUpIcon,
  SpinnerIcon,
  SwitchCameraIcon,
  TorchIcon,
} from '../ui/icons';
import type { CameraStatus, useCameraScanner } from './use-camera-scanner';

type Camera = ReturnType<typeof useCameraScanner>;

const PROBLEMS: Partial<Record<CameraStatus, { title: string; help: string }>> = {
  denied: {
    title: 'Camera access is blocked',
    help: 'Allow the camera for this site (tap the lock icon in the address bar, then Permissions, then Camera), and press Try again.',
  },
  'no-camera': {
    title: 'No camera found',
    help: 'Connect a webcam or use a phone or tablet. You can also scan from a photo of the code.',
  },
  insecure: {
    title: 'The camera needs a secure page',
    help: 'Open this app from its https:// address. Browsers only allow cameras on secure pages.',
  },
  busy: {
    title: 'The camera is in use',
    help: 'Close other apps or browser tabs that are using the camera, then press Try again.',
  },
  error: {
    title: 'The camera could not be started',
    help: 'Press Try again. If it keeps happening, reload the page or scan from a photo.',
  },
};

/** A round or pill-shaped control that floats over the picture: frosted dark glass, white icon. */
function GlassButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-medium',
        'bg-black/50 text-white ring-1 ring-inset ring-white/15 backdrop-blur-md',
        'transition-[background-color,transform] hover:bg-black/65 active:scale-95',
        'aria-pressed:bg-white aria-pressed:text-slate-900',
        className,
      )}
      {...rest}
    />
  );
}

/** Which camera to switch to: from the automatic (rear-facing) one, the first that is not rear-facing. */
function nextCameraId(camera: Camera): string {
  const list = camera.cameras;
  const at = list.findIndex((option) => option.id === camera.cameraId);
  if (at === -1) {
    const front = list.find((option) => !/back|rear|environment/i.test(option.label));
    return (front ?? list[0])?.id ?? '';
  }
  return list[(at + 1) % list.length]?.id ?? '';
}

/**
 * The live camera inside a rounded frame, with a clear scanning window, an animated sweep line and
 * corner marks; the controls (light, switch camera, scan a photo) float at the bottom. When the camera
 * cannot be used, the frame says why and what to do, and scanning from a photo is always on offer.
 */
export function CameraView({
  camera,
  onPhoto,
  busy = false,
  caption,
  className,
}: {
  camera: Camera;
  onPhoto: (file: File) => void;
  /** A code was read and the server is checking it. */
  busy?: boolean;
  caption?: ReactNode;
  className?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const problem = PROBLEMS[camera.status];
  const scanning = camera.status === 'scanning';

  return (
    <div className={cn('w-full', className)}>
      <div className="relative mx-auto aspect-[3/4] max-h-[72dvh] w-full overflow-hidden rounded-[1.75rem] bg-stage shadow-pop ring-1 ring-black/10 sm:aspect-[4/3] sm:max-h-[34rem]">
        <video
          ref={camera.videoRef}
          muted
          playsInline
          aria-label="Camera preview"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {scanning && !busy ? (
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            {/* sized from the frame's height and kept in its upper part, so the hint and the controls fit below it */}
            <div className="viewfinder-window absolute left-1/2 top-[11%] aspect-square h-[58%] -translate-x-1/2 rounded-[1.5rem]">
              <span className="absolute left-0 top-0 h-10 w-10 rounded-tl-[1.5rem] border-l-4 border-t-4 border-emerald-300" />
              <span className="absolute right-0 top-0 h-10 w-10 rounded-tr-[1.5rem] border-r-4 border-t-4 border-emerald-300" />
              <span className="absolute bottom-0 left-0 h-10 w-10 rounded-bl-[1.5rem] border-b-4 border-l-4 border-emerald-300" />
              <span className="absolute bottom-0 right-0 h-10 w-10 rounded-br-[1.5rem] border-b-4 border-r-4 border-emerald-300" />
              <span className="scan-line" />
            </div>
          </div>
        ) : null}

        {scanning && !busy ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-20 px-6 text-center text-sm font-medium text-white drop-shadow-[0_1px_6px_rgb(0_0_0/0.7)]">
            Align the QR code inside the frame
          </p>
        ) : null}

        {scanning ? (
          <div className="absolute left-3.5 top-3.5 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-inset ring-white/15 backdrop-blur-md">
            <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" />
            {busy ? 'Code read' : 'Ready to scan'}
          </div>
        ) : null}

        {camera.status === 'starting' ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stage/80 text-white"
          >
            <SpinnerIcon className="h-8 w-8" />
            <p className="text-sm font-medium">Opening the camera…</p>
            <p className="max-w-xs px-6 text-center text-xs text-slate-300">
              If your browser asks to use the camera, choose Allow.
            </p>
          </div>
        ) : null}

        {busy ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stage/75 text-white backdrop-blur-[3px]"
          >
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/10 ring-1 ring-inset ring-white/20">
              <SpinnerIcon className="h-8 w-8" />
            </span>
            <p className="text-base font-semibold">Verifying code…</p>
            <p className="max-w-xs px-6 text-center text-xs text-slate-300">
              Checking the employee and recording attendance.
            </p>
          </div>
        ) : null}

        {problem ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-y-auto bg-stage/92 p-6 text-center text-white"
          >
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-amber-300/15 text-amber-300 ring-1 ring-inset ring-amber-300/30">
              <CameraOffIcon className="h-7 w-7" />
            </span>
            <p className="text-lg font-semibold tracking-tight">{problem.title}</p>
            <p className="max-w-sm text-sm text-slate-300">{problem.help}</p>
            {camera.message && camera.status === 'error' ? (
              <p className="max-w-sm text-xs text-slate-400">{camera.message}</p>
            ) : null}
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {camera.status !== 'insecure' ? (
                <Button onClick={camera.retry}>
                  <CameraIcon className="h-4 w-4" /> Try again
                </Button>
              ) : null}
              <Button
                variant="outline"
                className="border-white/25 bg-white/10 text-white hover:bg-white/20"
                onClick={() => fileInput.current?.click()}
              >
                <ImageUpIcon className="h-4 w-4" /> Scan from a photo
              </Button>
            </div>
          </div>
        ) : null}

        {!problem && camera.status !== 'starting' && !busy ? (
          <div className="absolute inset-x-0 bottom-4 flex items-center justify-center gap-2.5 px-4">
            {camera.torch.available ? (
              <GlassButton
                aria-pressed={camera.torch.on}
                aria-label="Light"
                title="Light"
                onClick={() => void camera.toggleTorch()}
              >
                <TorchIcon className="h-5 w-5" />
              </GlassButton>
            ) : null}
            {camera.cameras.length > 1 ? (
              <GlassButton
                aria-label="Switch camera"
                title="Switch camera"
                onClick={() => camera.chooseCamera(nextCameraId(camera))}
              >
                <SwitchCameraIcon className="h-5 w-5" />
              </GlassButton>
            ) : null}
            <GlassButton
              aria-label="Scan from a photo"
              title="Scan from a photo"
              onClick={() => fileInput.current?.click()}
            >
              <ImageUpIcon className="h-5 w-5" />
              <span>From a photo</span>
            </GlassButton>
          </div>
        ) : null}
      </div>

      {caption ? <div className="mt-4 text-center text-sm text-muted">{caption}</div> : null}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Choose a photo of a QR code"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onPhoto(file);
        }}
      />
    </div>
  );
}
