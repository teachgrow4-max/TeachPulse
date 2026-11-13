import { Suspense, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { AuthUserDto, RoleName } from '@teachgrow/shared';
import { useAuth } from '../../lib/auth';
import { useMediaQuery } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import {
  DashboardIcon,
  HistoryIcon,
  IdCardIcon,
  LogOutIcon,
  MoreIcon,
  QrIcon,
  ScanIcon,
  SpinnerIcon,
  UserIcon,
  UserPlusIcon,
  type AppIcon,
} from '../ui/icons';
import { Logo } from '../ui/logo';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import { Avatar } from '../ui/misc';

const ROLE_LABEL: Record<RoleName, string> = {
  employee: 'Employee',
  admin: 'Administrator',
  attendance_operator: 'Attendance operator',
  office_display: 'Office display',
};

interface NavItem {
  to: string;
  label: string;
  icon: AppIcon;
  roles: RoleName[];
  group: 'Attendance' | 'People' | 'Account';
  /** Only for accounts whose own attendance is tracked. */
  needsAttendance?: boolean;
  /** On a phone: in the bottom bar. Everything else goes under "More". */
  tab?: boolean;
}

const NAV: NavItem[] = [
  {
    to: '/admin/attendance',
    label: 'Dashboard',
    icon: DashboardIcon,
    roles: ['admin'],
    group: 'Attendance',
    tab: true,
  },
  {
    to: '/scanner',
    label: 'QR Attendance',
    icon: ScanIcon,
    roles: ['admin', 'attendance_operator'],
    group: 'Attendance',
    tab: true,
  },
  {
    to: '/admin/qr',
    label: 'QR Management',
    icon: IdCardIcon,
    roles: ['admin'],
    group: 'Attendance',
    tab: true,
  },
  {
    to: '/admin/scan-history',
    label: 'Scan History',
    icon: HistoryIcon,
    roles: ['admin'],
    group: 'Attendance',
    tab: true,
  },
  {
    to: '/admin/employees/new',
    label: 'Add Employee',
    icon: UserPlusIcon,
    roles: ['admin'],
    group: 'People',
  },
  {
    to: '/attendance-qr',
    label: 'Attendance QR',
    icon: QrIcon,
    roles: ['employee', 'admin'],
    group: 'Account',
    needsAttendance: true,
    tab: true,
  },
  {
    to: '/profile',
    label: 'My Profile',
    icon: UserIcon,
    roles: ['employee', 'admin', 'attendance_operator'],
    group: 'Account',
    tab: true,
  },
];

/** The frame around every signed-in page: brand, who you are, and where you can go. */
export function AppShell() {
  const { user } = useAuth();
  const location = useLocation();
  const desktop = useMediaQuery('(min-width: 1024px)', true);
  if (!user) return null;
  const items = NAV.filter(
    (item) => item.roles.includes(user.role) && (!item.needsAttendance || user.attendanceRequired),
  );

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-brand-fg"
      >
        Skip to content
      </a>

      {desktop ? <Sidebar user={user} items={items} /> : <PhoneTopBar user={user} />}

      <div className={cn(desktop && 'pl-64')}>
        <main
          id="main"
          className={cn('min-h-dvh', !desktop && 'pb-[calc(4.75rem+env(safe-area-inset-bottom))]')}
        >
          <Suspense
            fallback={
              <div role="status" className="flex justify-center py-24 text-muted">
                <SpinnerIcon className="h-8 w-8" />
                <span className="sr-only">Loading…</span>
              </div>
            }
          >
            {/* Keyed on the route, so each page eases in as you arrive. */}
            <div key={location.pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>

      {desktop ? null : <PhoneTabBar user={user} items={items} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Laptop and desktop: a sidebar
// ---------------------------------------------------------------------------------------------

function Sidebar({ user, items }: { user: AuthUserDto; items: NavItem[] }) {
  const { logout } = useAuth();
  const groups = (['Attendance', 'People', 'Account'] as const)
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-line bg-surface">
      <div className="flex h-16 shrink-0 items-center px-5">
        <Logo />
      </div>

      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {groups.map(({ group, items: groupItems }) => (
          <div key={group} className="mb-1">
            <p className="px-3 pb-1.5 pt-4 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted">
              {group}
            </p>
            <ul className="flex flex-col gap-0.5">
              {groupItems.map((item) => (
                <li key={item.to}>
                  <SideLink item={item} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 rounded-xl p-2">
          <Avatar name={user.fullName} src={user.avatarUrl} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold leading-tight">{user.fullName}</p>
            <Badge tone="brand" className="mt-1">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start text-muted hover:text-fg"
          onClick={() => void logout()}
        >
          <LogOutIcon className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </aside>
  );
}

function SideLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-soft text-brand' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span
              aria-hidden="true"
              className="absolute -left-3 top-2 bottom-2 w-1 rounded-r-full bg-brand"
            />
          ) : null}
          <Icon className="h-[1.15rem] w-[1.15rem]" />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone and tablet: a slim top bar and a tab bar under the thumb
// ---------------------------------------------------------------------------------------------

function PhoneTopBar({ user }: { user: AuthUserDto }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface/85 px-4 backdrop-blur-md">
      <Logo />
      <Menu
        trigger={
          <button
            type="button"
            aria-label="Account menu"
            className="rounded-full outline-offset-2 transition-transform active:scale-95"
          >
            <Avatar name={user.fullName} src={user.avatarUrl} size="sm" />
          </button>
        }
      >
        <MenuLabel>
          <span className="block truncate text-sm font-semibold text-fg">{user.fullName}</span>
          <span className="block truncate">{ROLE_LABEL[user.role]}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem icon={UserIcon} onSelect={() => navigate('/profile')}>
          My Profile
        </MenuItem>
        <MenuItem icon={LogOutIcon} onSelect={() => void logout()}>
          Sign out
        </MenuItem>
      </Menu>
    </header>
  );
}

function PhoneTabBar({ user, items }: { user: AuthUserDto; items: NavItem[] }) {
  const { logout } = useAuth();
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = items.filter((item) => item.tab);
  // Four tabs fit beside "More"; anything beyond that (and every page that is not a tab) goes under it.
  const shown = tabs.length > 4 ? tabs.slice(0, 4) : tabs;
  const hidden = items.filter((item) => !shown.includes(item));

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md"
      >
        <ul className="mx-auto flex max-w-xl items-stretch">
          {shown.map((item) => (
            <li key={item.to} className="flex-1">
              <TabLink item={item} />
            </li>
          ))}
          {hidden.length > 0 ? (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                className="flex h-16 w-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium text-muted transition-colors hover:text-fg"
              >
                <MoreIcon className="h-5 w-5" />
                More
              </button>
            </li>
          ) : null}
        </ul>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen} title="More" size="sm">
        <ul className="flex flex-col gap-1">
          {hidden.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  onClick={() => setMoreOpen(false)}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors',
                      isActive ? 'bg-brand-soft text-brand' : 'hover:bg-surface-2',
                    )
                  }
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex items-center gap-3 border-t border-line pt-4">
          <Avatar name={user.fullName} src={user.avatarUrl} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{user.fullName}</p>
            <p className="truncate text-xs text-muted">{ROLE_LABEL[user.role]}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void logout()}>
            <LogOutIcon className="h-4 w-4" /> Sign out
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function TabLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          'relative flex h-16 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors',
          isActive ? 'text-brand' : 'text-muted hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-6 top-0 h-0.5 rounded-b-full bg-brand"
            />
          ) : null}
          <Icon className="h-5 w-5" />
          <span className="max-w-full truncate px-1">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}
