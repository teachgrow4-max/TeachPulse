import { Button } from './button';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/** Previous / next, with where you are. Hidden when everything fits on one page. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  busy?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center justify-between gap-3 px-1 pt-3 sm:px-0"
    >
      <p className="text-sm text-muted tabular-nums">
        {first}–{last} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || busy}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeftIcon className="h-4 w-4" /> Previous
        </Button>
        <span className="min-w-20 text-center text-sm text-muted tabular-nums" aria-live="polite">
          Page {page} of {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages || busy}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          Next <ChevronRightIcon className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}
