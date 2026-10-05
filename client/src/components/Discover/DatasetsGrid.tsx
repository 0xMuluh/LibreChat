import type { DiscoverDataset } from '~/data-provider';
import { useDiscoverDatasets } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { fieldIcon } from './fields';

type Props = {
  /** Show only this field; empty shows all. */
  field?: string;
  onSelect: (dataset: DiscoverDataset) => void;
};

export default function DatasetsGrid({ field = '', onSelect }: Props) {
  const localize = useLocalize();
  const { data = [] } = useDiscoverDatasets();
  const list = data.filter((d) => !field || d.domain === field);

  if (!list.length) {
    return (
      <p className="py-7 text-center text-sm text-text-tertiary">
        {field
          ? localize('com_discover_datasets_empty_field', { 0: field })
          : localize('com_discover_datasets_empty')}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
      {list.map((d) => {
        const Icon = fieldIcon(d.domain);
        return (
          <button
            key={`${d.pkg}:${d.name}`}
            type="button"
            onClick={() => onSelect(d)}
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
