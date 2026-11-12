import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { RoleName } from '@teachgrow/shared';
import { useAuth } from '../../lib/auth';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { LogOutIcon, QrIcon, ScanIcon, SpinnerIcon, UserIcon } from '../ui/icons';

const ROLE_LABEL: Record<RoleName, string> = {
  employee: 'Employee',
  admin: 'Administrator',
  attendance_operator: 'Attendance operator',
  office_display: 'Office display',
};

interface NavItem {
  to: string;
  label: string;
  icon: typeof QrIcon;
  roles: RoleName[];
}

const NAV: NavItem[] = [
  {
    to: '/scanner',
    label: 'QR attendance',
    icon: ScanIcon,
    roles: ['admin', 'attendance_operator'],
  },
  { to: '/admin/qr', label: 'QR management', icon: QrIcon, roles: ['admin'] },
  {
    to: '/profile',
    label: 'My profile',
    icon: UserIcon,
    roles: ['employee', 'admin', 'attendance_operator'],
  },
];

/** The frame around every signed-in page: brand, who you are, and where you can go. */
export function AppShell() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const items = NAV.filter((item) => item.roles.includes(user.role));

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand text-brand-fg">
              <QrIcon className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-bold">TeachGrow</p>
              <p className="text-xs text-muted">Attendance</p>
            </div>
          </div>

          <nav aria-label="Main" className="ml-2 hidden items-center gap-1 sm:flex">
            {items.map((item) => (
              <NavTab key={item.to} item={item} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight md:block">
              <p className="max-w-[12rem] truncate text-sm font-semibold">{user.fullName}</p>
              <Badge tone="brand" className="mt-0.5">
                {ROLE_LABEL[user.role]}
              </Badge>
            </div>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOutIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
              <span className="sr-only sm:hidden">Sign out</span>
            </Button>
          </div>
        </div>
        <nav
          aria-label="Main"
          className="flex gap-1 overflow-x-auto border-t border-line px-3 py-1.5 sm:hidden"
        >
          {items.map((item) => (
            <NavTab key={item.to} item={item} />
          ))}
        </nav>
      </header>

      <main id="main" className="flex-1 pb-10">
        <Suspense
          fallback={
            <div role="status" className="flex justify-center py-20 text-muted">
              <SpinnerIcon className="h-8 w-8" />
              <span className="sr-only">Loading…</span>
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

function NavTab({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
          isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </NavLink>
  );
}
