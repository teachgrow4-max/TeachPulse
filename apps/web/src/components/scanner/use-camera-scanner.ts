import { useCallback, useEffect, useRef, useState } from 'react';
import { safeStorage } from '../../lib/utils';

/**
 * The camera, and the QR decoder looking through it.
 *
 * Works on Android and iOS browsers and on desktop webcams. A camera can only be used on a secure
 * page (https, or localhost), and only after the person says yes; every way that can go wrong has
 * its own status, so the screen can say what to do about it.
 */

export type CameraStatus =
  | 'idle' // not asked to run
  | 'starting' // asking for permission / opening the camera
  | 'scanning' // looking for a code
  | 'denied' // the person (or their browser policy) said no
  | 'no-camera' // none found
  | 'insecure' // the page is not https
  | 'busy' // another app has the camera
  | 'error';

export interface CameraInfo {
  id: string;
  label: string;
}

const CAMERA_KEY = 'tg.scanner.camera';
/** The same code is not reported twice within this time: a steady hand sees it dozens of times. */
const REPEAT_WINDOW_MS = 2500;

export function classifyCameraError(error: unknown): { status: CameraStatus; message: string } {
  const name = error instanceof DOMException ? error.name : '';
  const text = String(error instanceof Error ? error.message : error);
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission/i.test(text)) {
    return { status: 'denied', message: 'Camera access was blocked.' };
  }
  if (
    name === 'NotFoundError' ||
    name === 'DevicesNotFoundError' ||
    /camera not found/i.test(text)
  ) {
    return { status: 'no-camera', message: 'No camera was found on this device.' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return { status: 'busy', message: 'The camera is being used by another app or tab.' };
  }
  return { status: 'error', message: text || 'The camera could not be started.' };
}

export function useCameraScanner({
  enabled,
  onDecode,
}: {
  enabled: boolean;
  onDecode: (text: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<{ toggleFlash(): Promise<void>; isFlashOn(): boolean } | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [cameraId, setCameraIdState] = useState<string>(() => safeStorage.get(CAMERA_KEY) ?? '');
  const [torch, setTorch] = useState<{ available: boolean; on: boolean }>({
    available: false,
    on: false,
  });
  const [attempt, setAttempt] = useState(0);

  const decodeRef = useRef(onDecode);
  useEffect(() => {
    decodeRef.current = onDecode;
  }, [onDecode]);
  const lastSeen = useRef<{ text: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let scanner: {
      start(): Promise<void>;
      stop(): void;
      destroy(): void;
      hasFlash(): Promise<boolean>;
      toggleFlash(): Promise<void>;
      isFlashOn(): boolean;
    } | null = null;

    void (async () => {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setStatus('insecure');
        setMessage('The camera only works on a secure (https) page.');
        return;
      }
      setStatus('starting');
      setMessage(null);
      try {
        // The decoder is large; it is only fetched when the scanner is actually opened.
        const { default: QrScanner } = await import('qr-scanner');
        if (cancelled) return;
        if (!(await QrScanner.hasCamera())) {
          setStatus('no-camera');
          setMessage('No camera was found on this device.');
          return;
        }
        const video = videoRef.current;
        if (!video) return;

        scanner = new QrScanner(
          video,
          (result) => {
            const now = Date.now();
            const previous = lastSeen.current;
            if (previous && previous.text === result.data && now - previous.at < REPEAT_WINDOW_MS) {
              lastSeen.current = { text: result.data, at: now };
              return;
            }
            lastSeen.current = { text: result.data, at: now };
            decodeRef.current(result.data);
          },
          {
            preferredCamera: cameraId || 'environment',
            returnDetailedScanResult: true,
            maxScansPerSecond: 10,
            highlightScanRegion: false,
            highlightCodeOutline: false,
          },
        );
        scannerRef.current = scanner;
        await scanner.start();
        if (cancelled) {
          scanner.stop();
          scanner.destroy();
          return;
        }
        setStatus('scanning');
        // Camera names are only available once permission has been given.
        const list = await QrScanner.listCameras(true);
        if (cancelled) return;
        setCameras(list.map((camera) => ({ id: camera.id, label: camera.label })));
        setTorch({ available: await scanner.hasFlash(), on: false });
      } catch (error) {
        if (cancelled) return;
        const failure = classifyCameraError(error);
        setStatus(failure.status);
        setMessage(failure.message);
      }
    })();

    return () => {
      cancelled = true;
      scannerRef.current = null;
      if (scanner) {
        scanner.stop();
        scanner.destroy();
      }
    };
  }, [enabled, cameraId, attempt]);

  const chooseCamera = useCallback((id: string) => {
    safeStorage.set(CAMERA_KEY, id);
    setCameraIdState(id);
  }, []);

  const toggleTorch = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    await scanner.toggleFlash();
    setTorch((current) => ({ ...current, on: scanner.isFlashOn() }));
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { videoRef, status, message, cameras, cameraId, chooseCamera, torch, toggleTorch, retry };
}

/** Reads a QR code from a photo (for when the live camera is not an option). */
export async function decodePhoto(file: File): Promise<string> {
  const { default: QrScanner } = await import('qr-scanner');
  const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
  return result.data;
}
