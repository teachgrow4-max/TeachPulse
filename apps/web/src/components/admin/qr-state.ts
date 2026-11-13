import type { QrOverviewRow, QrOverviewState } from '@teachgrow/shared';
import { formatTime } from '../../lib/format';
import type { BadgeTone } from '../ui/badge';

/** How each state of an employee's QR for a day is named and coloured. */
const LOOK: Record<QrOverviewState, { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  USED: { label: 'Scanned', tone: 'info' },
  EXPIRED: { label: 'Expired', tone: 'warning' },
  NONE: { label: 'Not generated', tone: 'neutral' },
};

export const qrStateLook = (state: QrOverviewState) => LOOK[state];

const ACTION = { CHECK_IN: 'Check-in', CHECK_OUT: 'Check-out' } as const;

/** One line under the badge: what the latest code is for and when it matters. */
export function qrStateDetail(row: Pick<QrOverviewRow, 'state' | 'latest'>): string {
  const latest = row.latest;
  if (!latest) return 'No code was made.';
  const what = `${ACTION[latest.action]} code`;
  switch (row.state) {
    case 'ACTIVE':
      return `${what} · valid until ${formatTime(latest.expiresAt)}`;
    case 'USED':
      return `${what} · scanned at ${formatTime(latest.usedAt)}`;
    case 'EXPIRED':
      return `${what} · ran out at ${formatTime(latest.expiresAt)}, never scanned`;
    default:
      return 'No code was made.';
  }
}
