import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../lib/utils';
import { AlertCircleIcon, AlertIcon, CheckCircleIcon, InfoIcon, XIcon } from './icons';

type Tone = 'success' | 'danger' | 'info' | 'warning';
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  text?: string;
}

interface ToastApi {
  show(toast: { tone?: Tone; title: string; text?: string }): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DURATION_MS = 6000;

const ICONS = {
  success: CheckCircleIcon,
  danger: AlertCircleIcon,
  warning: AlertIcon,
  info: InfoIcon,
} as const;

const ICON_TONES = {
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
} as const;

/** Short confirmations ("Password copied") that fade by themselves and are read out by screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback<ToastApi['show']>(
    ({ tone = 'info', title, text }) => {
      const id = next.current++;
      setToasts((all) => [...all.slice(-3), { id, tone, title, text }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const active = timers.current;
    return () => {
      active.forEach(clearTimeout);
      active.clear();
    };
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        // On a phone the tab bar sits at the bottom, so the toasts rise above it.
        className={cn(
          'pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3',
          'pb-[max(0.75rem,env(safe-area-inset-bottom))] max-lg:pb-[calc(4.75rem+env(safe-area-inset-bottom))]',
          'sm:items-end sm:p-5',
        )}
      >
        {toasts.map((toast) => {
          const Icon = ICONS[toast.tone];
          return (
            <div
              key={toast.id}
              className="toast-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-pop"
            >
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  ICON_TONES[toast.tone],
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5 text-sm">
                <p className="font-semibold leading-tight">{toast.title}</p>
                {toast.text ? <p className="mt-0.5 text-muted">{toast.text}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded-lg p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                aria-label="Dismiss"
              >
                <XIcon className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>.');
  return value;
}
