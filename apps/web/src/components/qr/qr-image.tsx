import { useMemo } from 'react';
import { qrPath } from '../../lib/qr-card';
import { cn } from '../../lib/utils';

/**
 * A QR code as a crisp vector image. Always black on white, with its own quiet zone, so it scans
 * the same in light and dark mode and at any size.
 */
export function QrImage({
  payload,
  label,
  className,
}: {
  payload: string;
  label: string;
  className?: string;
}) {
  const { total, d } = useMemo(() => qrPath(payload), [payload]);
  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn('block h-auto w-full rounded-lg bg-white', className)}
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
