import { useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { AlertIcon, CameraIcon, ImageIcon, SpinnerIcon, TorchIcon } from '../ui/icons';
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

/**
 * The live camera with a scanning frame, and the controls around it: which camera, the torch, and
 * a way in for people who cannot use the camera at all (scan a photo of the code).
 */
export function CameraView({
  camera,
  onPhoto,
  caption,
  className,
}: {
  camera: Camera;
  onPhoto: (file: File) => void;
  caption?: ReactNode;
  className?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const problem = PROBLEMS[camera.status];

  return (
    <div className={cn('mx-auto w-full max-w-xl', className)}>
      <div className="relative aspect-square max-h-[68dvh] w-full overflow-hidden rounded-3xl bg-stage shadow-card sm:aspect-[4/3]">
        <video
          ref={camera.videoRef}
          muted
          playsInline
          aria-label="Camera preview"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {camera.status === 'scanning' ? (
          <div className="pointer-events-none absolute inset-[14%]" aria-hidden="true">
            <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-4 border-t-4 border-emerald-400" />
            <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-4 border-t-4 border-emerald-400" />
            <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-4 border-l-4 border-emerald-400" />
            <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-4 border-r-4 border-emerald-400" />
            <span className="scan-line" />
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

        {problem ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stage/90 p-6 text-center text-white"
          >
            <AlertIcon className="h-9 w-9 text-amber-300" />
            <p className="text-lg font-semibold">{problem.title}</p>
            <p className="max-w-sm text-sm text-slate-300">{problem.help}</p>
            {camera.message && camera.status === 'error' ? (
              <p className="max-w-sm text-xs text-slate-400">{camera.message}</p>
            ) : null}
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              {camera.status !== 'insecure' ? (
                <Button onClick={camera.retry}>
                  <CameraIcon /> Try again
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => fileInput.current?.click()}>
                <ImageIcon /> Scan from a photo
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {caption ? <div className="mt-3 text-center text-sm text-muted">{caption}</div> : null}

      <div className="mt-3 flex flex-wrap items-end justify-center gap-3">
        {camera.cameras.length > 1 ? (
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted sm:max-w-xs">
            Camera
            <select
              value={camera.cameraId}
              onChange={(event) => camera.chooseCamera(event.target.value)}
              className="h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-fg"
            >
              <option value="">Automatic</option>
              {camera.cameras.map((option, index) => (
                <option key={option.id} value={option.id}>
                  {option.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {camera.torch.available ? (
          <Button
            variant="outline"
            aria-pressed={camera.torch.on}
            onClick={() => void camera.toggleTorch()}
          >
            <TorchIcon /> {camera.torch.on ? 'Light on' : 'Light'}
          </Button>
        ) : null}

        <Button variant="ghost" onClick={() => fileInput.current?.click()}>
          <ImageIcon /> Scan from a photo
        </Button>
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
    </div>
  );
}
