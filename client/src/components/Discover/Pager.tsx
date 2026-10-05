import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Props = {
  page: number;
  pages: number;
  first: number;
  count: number;
  total: number;
  onPage: (page: number) => void;
};

/** Page numbers with the first, last and two neighbours of the current page. */
export default function Pager({ page, pages, first, count, total, onPage }: Props) {
  const localize = useLocalize();
  const numbers = [...new Set([1, page - 1, page, page + 1, pages])]
    .filter((n) => n >= 1 && n <= pages)
    .sort((a, b) => a - b);

  const step = 'rounded-lg px-2.5 py-1 text-[13px] font-medium text-text-secondary';
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-2.5"
      aria-label={localize('com_discover_pages')}
    >
      <span className="text-[13px] text-text-tertiary">
        {localize('com_discover_page_range', { 0: first, 1: first + count - 1, 2: total })}
      </span>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          className={cn(step, 'hover:bg-surface-hover disabled:cursor-default disabled:opacity-40')}
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          {localize('com_discover_previous')}
        </button>
        {numbers.map((n, i) => (
          <span key={n} className="inline-flex items-center gap-1">
            {i > 0 && n - numbers[i - 1] > 1 && (
              <span className="px-1 text-text-tertiary" aria-hidden="true">
                …
              </span>
            )}
            <button
              type="button"
              aria-current={n === page ? 'page' : undefined}
              onClick={() => onPage(n)}
              className={cn(
                step,
                'min-w-8',
                n === page ? 'bg-accent-primary text-surface-primary' : 'hover:bg-surface-hover',
              )}
            >
              {n}
            </button>
          </span>
        ))}
        <button
          type="button"
          className={cn(step, 'hover:bg-surface-hover disabled:cursor-default disabled:opacity-40')}
          disabled={page === pages}
          onClick={() => onPage(page + 1)}
        >
          {localize('com_discover_next')}
        </button>
      </span>
    </nav>
  );
}
