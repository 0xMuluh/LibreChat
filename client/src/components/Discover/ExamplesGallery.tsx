import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useDiscoverExamples } from '~/data-provider';
import ExampleCard from './ExampleCard';
import { useLocalize } from '~/hooks';
import { sortFields } from './fields';
import { cn } from '~/utils';
import Pager from './Pager';

const PAGE_SIZE = 12;
const MODES: { value: string; label: TranslationKeys; hint?: TranslationKeys }[] = [
  { value: '', label: 'com_discover_all' },
  { value: 'notes', label: 'com_discover_notes', hint: 'com_discover_notes_hint' },
  { value: 'reports', label: 'com_discover_reports', hint: 'com_discover_reports_hint' },
];

type Props = {
  /** Called with the active field, so a datasets list below can follow it. */
  onFieldChange?: (field: string) => void;
  /** Search text from outside, e.g. a shared search box. */
  query?: string;
  showSearch?: boolean;
};

export default function ExamplesGallery({ onFieldChange, query, showSearch = true }: Props) {
  const localize = useLocalize();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [field, setField] = useState('');
  const [mode, setMode] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setQ((query ?? text).trim()), 250);
    return () => clearTimeout(timer);
  }, [text, query]);

  useEffect(() => setPage(1), [q, field, mode]);
  useEffect(() => onFieldChange?.(field), [field, onFieldChange]);

  const { data, isLoading, isError } = useDiscoverExamples({
    page,
    pageSize: PAGE_SIZE,
    field,
    mode,
    q,
  });
  const fields = sortFields(data?.fields ?? []);

  let emptyText = localize('com_discover_examples_empty');
  if (isError) {
    emptyText = localize('com_discover_examples_error');
  } else if (q) {
    emptyText = localize('com_discover_examples_no_match', { 0: q });
  }

  return (
    <div className="flex flex-col gap-4">
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
                  ? 'border-transparent bg-text-primary text-surface-primary'
                  : 'border-border-medium text-text-secondary hover:bg-surface-hover',
              )}
            >
              {value || localize('com_discover_all')}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {showSearch && (
            <label className="flex items-center gap-2 rounded-lg border border-border-light bg-surface-primary px-2.5 py-1.5 text-text-tertiary focus-within:border-border-heavy">
              <Search className="size-4" aria-hidden="true" />
              <input
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={localize('com_discover_search_examples')}
                aria-label={localize('com_discover_search_examples')}
                className="w-44 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </label>
          )}
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
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5">
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
          onPage={setPage}
        />
      )}
    </div>
  );
}
