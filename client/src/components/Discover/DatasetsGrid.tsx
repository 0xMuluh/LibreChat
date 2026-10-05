import { useState } from 'react';
import { datasetPrompt, discoverSeed, useDiscoverDatasets } from '~/data-provider';
import OpenStudies from './OpenStudies';
import { useLocalize } from '~/hooks';
import { fieldIcon } from './fields';
import { cn } from '~/utils';

type Props = {
  /** Show only this field; empty shows all. */
  field?: string;
  /** Search text from the page's search box. */
  query?: string;
  /** Called with the starter prompt for the dataset or study picked. */
  onPrompt: (prompt: string) => void;
};

/** Built-in datasets from R packages, and open studies from MGnify and Zenodo. */
export default function DatasetsGrid({ field = '', query = '', onPrompt }: Props) {
  const localize = useLocalize();
  const [tab, setTab] = useState<'builtin' | 'open'>('builtin');

  const tabs = (
    <div
      className="inline-flex self-start rounded-lg border border-border-light bg-surface-secondary p-0.5"
      role="tablist"
      aria-label={localize('com_ui_datasets')}
    >
      {(
        [
          ['builtin', localize('com_discover_datasets_builtin')],
          ['open', localize('com_discover_datasets_open')],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          onClick={() => setTab(value)}
          className={cn(
            'rounded-md px-3 py-1 text-[13px] font-medium',
            tab === value
              ? 'bg-surface-primary text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-primary',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  let body = <BuiltIn field={field} query={query} onPrompt={onPrompt} />;
  if (tab === 'open') {
    body =
      field && field !== 'Microbiome' ? (
        <p className="py-7 text-center text-sm text-text-tertiary">
          {localize('com_discover_studies_microbiome_only')}
        </p>
      ) : (
        <OpenStudies query={query} onPrompt={onPrompt} />
      );
  }

  return (
    <div className="flex flex-col gap-4">
      {tabs}
      {body}
    </div>
  );
}

function BuiltIn({ field = '', query = '', onPrompt }: Props) {
  const localize = useLocalize();
  const { data = [] } = useDiscoverDatasets(discoverSeed());
  const q = query.trim().toLowerCase();
  const list = data.filter(
    (d) =>
      (!field || d.domain === field) &&
      (!q ||
        [d.name, d.pkg, d.desc, d.domain, d.species, d.cls].join(' ').toLowerCase().includes(q)),
  );

  let emptyText = localize('com_discover_datasets_empty');
  if (q) {
    emptyText = localize('com_discover_datasets_no_match', { 0: query.trim() });
  } else if (field) {
    emptyText = localize('com_discover_datasets_empty_field', { 0: field });
  }

  if (!list.length) {
    return <p className="py-7 text-center text-sm text-text-tertiary">{emptyText}</p>;
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
      {list.map((d) => {
        const Icon = fieldIcon(d.domain);
        return (
          <button
            key={`${d.pkg}:${d.name}`}
            type="button"
            onClick={() => onPrompt(datasetPrompt(d))}
            className="flex items-start gap-3 rounded-xl border border-border-light bg-surface-primary p-3 text-left transition-colors hover:border-border-heavy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
          >
            <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface-secondary text-text-secondary">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-[13px] font-medium text-text-primary">{d.name}</span>
              <span className="text-[13px] leading-snug text-text-secondary">{d.desc}</span>
              <span className="text-xs text-text-tertiary">
                {d.pkg} · {d.species}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
