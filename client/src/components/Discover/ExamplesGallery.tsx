import { useEffect, useRef, useState } from 'react';
import type { TranslationKeys } from '~/hooks';
import { discoverSeed, useDiscoverExamples } from '~/data-provider';
import ExampleCard from './ExampleCard';
import { useLocalize } from '~/hooks';
import { sortFields } from './fields';
import { cn } from '~/utils';
import Pager from './Pager';

/** A page is this many full rows of cards, however many columns fit. */
const ROWS_PER_PAGE = 2;
const MODES: { value: string; label: TranslationKeys; hint?: TranslationKeys }[] = [
  { value: '', label: 'com_discover_all' },
  { value: 'notes', label: 'com_discover_notes', hint: 'com_discover_notes_hint' },
  { value: 'reports', label: 'com_discover_reports', hint: 'com_discover_reports_hint' },
];

type Props = {
  /** Called with the active field, so a datasets list below can follow it. */
  onFieldChange?: (field: string) => void;
  /** Search text from the page's search box. */
  query?: string;
};

export default function ExamplesGallery({ onFieldChange, query = '' }: Props) {
  const localize = useLocalize();
  const [q, setQ] = useState('');
  const [field, setField] = useState('');
  const [mode, setMode] = useState('');
  const [page, setPage] = useState(1);
  const [columns, setColumns] = useState(4);
  const gridRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);

  /* Count the grid's columns so a page is always two full rows. */
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    const measure = () =>
      setColumns(Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  const pageSize = columns * ROWS_PER_PAGE;

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => setPage(1), [q, field, mode]);
  useEffect(() => onFieldChange?.(field), [field, onFieldChange]);

  const { data, isLoading, isError, isFetching } = useDiscoverExamples({
    page,
    pageSize,
    field,
    mode,
    q,
    seed: discoverSeed(),
  });
  const fields = sortFields(data?.fields ?? []);

  let emptyText = localize('com_discover_examples_empty');
  if (isError) {
    emptyText = localize('com_discover_examples_error');
  } else if (q) {
    emptyText = localize('com_discover_examples_no_match', { 0: q });
  }

  /* When the column count changes, stay near the first card that was on screen. */
  const firstShown = useRef(0);
  useEffect(() => {
    setPage(Math.floor(firstShown.current / pageSize) + 1);
  }, [pageSize]);
  if (data) {
    firstShown.current = (data.page - 1) * data.pageSize;
  }

  const goTo = (next: number) => {
    setPage(next);
    /* Bring the first row back into view if it is above the screen. */
    const top = sectionRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 0) {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="flex scroll-mt-16 flex-col gap-4" ref={sectionRef}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={localize('com_discover_filter_field')}
        >
          {['', ...fields].map((value) => (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={field === value}
              onClick={() => setField(value)}
              className={cn(
                'rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                field === value
                  ? 'border-transparent bg-accent-primary text-surface-primary'
                  : 'border-border-medium text-text-secondary hover:bg-surface-hover',
              )}
            >
              {value || localize('com_discover_all')}
            </button>
          ))}
        </div>
        <div
          className="inline-flex rounded-lg border border-border-light bg-surface-secondary p-0.5"
          role="group"
          aria-label={localize('com_discover_filter_mode')}
        >
          {MODES.map((m) => (
            <button
              key={localize(m.label)}
              type="button"
              title={m.hint ? localize(m.hint) : undefined}
              aria-pressed={mode === m.value}
              onClick={() => setMode(m.value)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] font-medium',
                mode === m.value
                  ? 'bg-surface-primary text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {localize(m.label)}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={gridRef}
        className={cn(
          'grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5 transition-opacity',
          isFetching && 'opacity-60',
        )}
      >
        {(data?.items ?? []).map((example) => (
          <ExampleCard key={example.shareId} example={example} />
        ))}
      </div>

      {!isLoading && (data?.total ?? 0) === 0 && (
        <p className="py-7 text-center text-sm text-text-tertiary">{emptyText}</p>
      )}

      {data && data.pages > 1 && (
        <Pager
          page={data.page}
          pages={data.pages}
          first={(data.page - 1) * data.pageSize + 1}
          count={data.items.length}
          total={data.total}
          onPage={goTo}
        />
      )}
    </div>
  );
}
