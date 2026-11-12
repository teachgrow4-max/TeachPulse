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
import { AlertIcon, CheckIcon, InfoIcon, XIcon } from './icons';

type Tone = 'success' | 'danger' | 'info';
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

/** Short confirmations ("Code regenerated") that fade by themselves and are read out by screen readers. */
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
  const icons = { success: CheckIcon, danger: AlertIcon, info: InfoIcon } as const;
  const tones = {
    success: 'border-success-solid/40',
    danger: 'border-danger-solid/40',
    info: 'border-line',
  } as const;
  const iconTones = {
    success: 'text-success-solid',
    danger: 'text-danger-solid',
    info: 'text-info-solid',
  } as const;

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {toasts.map((toast) => {
          const Icon = icons[toast.tone];
          return (
            <div
              key={toast.id}
              className={cn(
                'pop-in pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border',
                'bg-surface p-3.5 shadow-card',
                tones[toast.tone],
              )}
            >
              <Icon className={cn('mt-0.5', iconTones[toast.tone])} />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">{toast.title}</p>
                {toast.text ? <p className="text-muted">{toast.text}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="rounded p-1 text-muted hover:text-fg"
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
