import type { ReactNode } from 'react';
import { ClockIcon, QrIcon, ShieldCheckIcon, type AppIcon } from '../ui/icons';
import { Logo } from '../ui/logo';

const POINTS: Array<{ icon: AppIcon; title: string; text: string }> = [
  {
    icon: ShieldCheckIcon,
    title: 'Proven at the office',
    text: 'Your location and the office Wi-Fi are checked before a code is made.',
  },
  {
    icon: QrIcon,
    title: 'Short-lived QR codes',
    text: 'Every code works once and runs out within minutes.',
  },
  {
    icon: ClockIcon,
    title: 'Recorded in seconds',
    text: 'An administrator scans it and your attendance is logged straight away.',
  },
];

/**
 * The frame for the pages you see before you are signed in: a brand panel on a wide screen, and
 * just the logo and the form on a phone.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="bg-brand-gradient relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex">
        {/* soft decorative shapes; they carry no information */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-20 h-[26rem] w-[26rem] rounded-full bg-black/10"
        />
        <Logo tone="inverse" className="relative" />
        <div className="relative">
          <h2 className="max-w-md text-4xl font-semibold leading-[1.15] tracking-tight">
            Attendance that proves itself.
          </h2>
          <ul className="mt-9 flex max-w-md flex-col gap-5">
            {POINTS.map(({ icon: Icon, title: heading, text }) => (
              <li key={heading} className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-inset ring-white/25">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="font-semibold">{heading}</p>
                  <p className="text-sm text-white/85">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/80">TeachGrow Attendance</p>
      </aside>

      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? (
            <p className="mb-6 mt-1.5 text-sm text-muted">{subtitle}</p>
          ) : (
            <div className="mb-6" />
          )}
          {children}
          {footer ? <div className="mt-5 text-center text-xs text-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
