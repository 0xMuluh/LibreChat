import { forwardRef, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { FieldNode } from './fields';
import { discoverSeed, useDiscoverExamples } from '~/data-provider';
import ExampleCard from './ExampleCard';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Props = {
  node: FieldNode;
  mode: string;
  /** Marks the row of the node lit in the network. */
  active: boolean;
};

/** OmicsBase: one network node's examples, a page of cards at a time. */
const FieldCarousel = forwardRef<HTMLElement, Props>(function FieldCarousel(
  { node, mode, active },
  ref,
) {
  const localize = useLocalize();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(2);
  const title = localize(node.label);
  const headingId = `examples-${node.id}`;

  /* Two cards side by side, one on a narrow screen, as in the landing reference. */
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 768px)');
    const update = () => setPageSize(wide.matches ? 2 : 1);
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, []);

  useEffect(() => setPage(1), [mode, pageSize]);

  const { data, isFetching } = useDiscoverExamples({
    page,
    pageSize,
    field: node.fields.join(','),
    mode,
    seed: discoverSeed(),
  });
  const pages = data?.pages ?? 1;
  const step = (by: number) => setPage((p) => ((p - 1 + by + pages) % pages) + 1);
  const arrow =
    'flex size-7 items-center justify-center rounded-full border border-border-medium text-text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary';

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-node={node.id}
      className={cn(
        'bg-surface-primary/70 scroll-mt-20 rounded-2xl border p-4 backdrop-blur-sm transition-colors',
        'relative',
        active ? 'border-transparent' : 'border-border-light',
      )}
    >
      {active && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          {[
            [node.light, 'dark:hidden'],
            [node.dark, 'hidden dark:block'],
          ].map(([colour, show]) => (
            <rect
              key={show}
              className={show}
              x="-0.25"
              y="-0.25"
              width="calc(100% + 0.5px)"
              height="calc(100% + 0.5px)"
              rx="16"
              fill="none"
              stroke={colour}
              strokeWidth="1.5"
            />
          ))}
        </svg>
      )}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={headingId} className="font-display flex items-center gap-2 text-lg font-medium">
          {title}
          {data && (
            <>
              <span className="text-text-tertiary font-sans text-sm font-normal" aria-hidden="true">
                {data.total}
              </span>
              <span className="sr-only">
                {localize('com_discover_examples_count', { 0: data.total })}
              </span>
            </>
          )}
        </h3>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary text-xs tabular-nums" aria-live="polite">
              {localize('com_discover_page_of', { 0: page, 1: pages })}
            </span>
            <button
              type="button"
              className={arrow}
              onClick={() => step(-1)}
              aria-label={localize('com_discover_previous_in', { 0: title })}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={arrow}
              onClick={() => step(1)}
              aria-label={localize('com_discover_next_in', { 0: title })}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      <div
        className={cn(
          'grid gap-3 transition-opacity',
          pageSize === 2 ? 'grid-cols-2' : 'grid-cols-1',
          isFetching && 'opacity-60',
        )}
      >
        {(data?.items ?? []).map((example) => (
          <ExampleCard key={example.shareId} example={example} />
        ))}
      </div>
      {data && data.total === 0 && (
        <p className="text-text-tertiary py-6 text-center text-sm">
          {localize('com_discover_examples_empty')}
        </p>
      )}
    </section>
  );
});

export default FieldCarousel;
