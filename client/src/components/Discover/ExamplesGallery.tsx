import { useEffect, useRef, useState } from 'react';
import type { TranslationKeys } from '~/hooks';
import { discoverSeed, useDiscoverExamples, useGetStartupConfig } from '~/data-provider';
import { FIELD_NODES, HUB_NODE } from './fields';
import FieldCarousel from './FieldCarousel';
import FieldNetwork from './FieldNetwork';
import ExampleCard from './ExampleCard';
import { useLocalize } from '~/hooks';
import NodeCard from './NodeCard';
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
  /** Called with the chosen node's fields, comma-separated, so a datasets list below can follow it. */
  onFieldChange?: (field: string) => void;
  /** Search text from the page's search box. */
  query?: string;
};

export default function ExamplesGallery({ onFieldChange, query = '' }: Props) {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const localReports = startupConfig?.reportsMode === 'local';
  const [q, setQ] = useState('');
  /** The network node chosen as a filter; '' is all. */
  const [node, setNode] = useState('');
  const field = FIELD_NODES.find((n) => n.id === node)?.fields.join(',') ?? '';
  const [mode, setMode] = useState('');
  const [page, setPage] = useState(1);
  const [columns, setColumns] = useState(4);
  /** Without a search the fields show as carousels; the paged grid shows search results. */
  const searching = q !== '';
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
  }, [searching]);
  const pageSize = columns * ROWS_PER_PAGE;
  const carouselRefs = useRef<Record<string, HTMLElement | null>>({});
  /** The node whose row is in the middle of the screen, as in the landing reference. */
  const [inView, setInView] = useState('');
  const [hovered, setHovered] = useState('');
  /** The node the card under the network describes, in the network's own order of precedence. */
  const lit =
    [HUB_NODE, ...FIELD_NODES].find((n) => n.id === (hovered || node || inView)) ?? HUB_NODE;

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => setPage(1), [q, field, mode]);
  useEffect(() => onFieldChange?.(field), [field, onFieldChange]);

  const { data, isLoading, isError, isFetching } = useDiscoverExamples({
    page,
    pageSize: searching ? pageSize : 1,
    field,
    mode,
    q,
    seed: discoverSeed(),
  });
  /* Nodes with real notes get a row; the others are drawn but have none yet. */
  const fields = data?.fields ?? [];
  const rows = FIELD_NODES.filter((n) => n.fields.some((f) => fields.includes(f)));

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

  const chooseNode = (value: string) => {
    setNode(value);
    if (!searching && value) {
      carouselRefs.current[value]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  useEffect(() => {
    if (searching) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView((entry.target as HTMLElement).dataset.node ?? '');
          }
        }),
      { rootMargin: '-32% 0px -46% 0px', threshold: 0.1 },
    );
    Object.values(carouselRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [searching, rows.length]);

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
      <div className="flex justify-end">
        <div
          className="border-border-light bg-surface-secondary inline-flex rounded-lg border p-0.5"
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
                'text-1xs rounded-md px-3 py-1 font-medium',
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

      <div className="grid gap-6 min-[980px]:grid-cols-[minmax(0,0.94fr)_minmax(0,1.1fr)]">
        <div className="flex flex-col gap-4 min-[980px]:sticky min-[980px]:top-[74px] min-[980px]:self-start">
          <div className="border-border-medium bg-surface-primary/80 overflow-hidden rounded-2xl border shadow-lg backdrop-blur-xl">
            <FieldNetwork
              selected={node}
              inView={inView}
              onSelect={chooseNode}
              onHover={setHovered}
              localReports={localReports}
            />
          </div>
          <NodeCard node={lit} localReports={localReports} />
        </div>

        {searching ? (
          <div className="flex flex-col gap-4">
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
              <p className="text-text-tertiary py-7 text-center text-sm">{emptyText}</p>
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
        ) : (
          <div className="flex flex-col gap-4">
            {rows.map((row) => (
              <FieldCarousel
                key={row.id}
                node={row}
                mode={mode}
                active={node ? node === row.id : inView === row.id}
                ref={(el) => {
                  carouselRefs.current[row.id] = el;
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
