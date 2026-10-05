import { useMemo } from 'react';
import { useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { DiscoverDataset, DiscoverExample } from '~/data-provider';
import {
  datasetPrompt,
  exampleCoverUrl,
  exampleShareUrl,
  useDiscoverDatasets,
  useDiscoverExamples,
} from '~/data-provider';
import { useChatFormContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import { fieldIcon } from './fields';

const STRIP_SIZE = 4;

type Suggestion =
  | { kind: 'example'; item: DiscoverExample }
  | { kind: 'dataset'; item: DiscoverDataset };

/** Three examples from different fields and one dataset, rotating daily. */
function pick(examples: DiscoverExample[], datasets: DiscoverDataset[]): Suggestion[] {
  const day = Math.floor(Date.now() / 86_400_000);
  const pool = examples.filter((example) => example.hasCover);
  const picks: Suggestion[] = [];
  const fields = new Set<string>();
  for (let i = 0; i < pool.length && picks.length < STRIP_SIZE - 1; i++) {
    const example = pool[(day * 7 + i * 13) % pool.length];
    if (fields.has(example.field) || picks.some((p) => p.item === example)) {
      continue;
    }
    fields.add(example.field);
    picks.push({ kind: 'example', item: example });
  }
  if (datasets.length) {
    picks.push({ kind: 'dataset', item: datasets[day % datasets.length] });
  }
  return picks;
}

/**
 * OmicsBase: a few starting points under the composer of a new note. It goes
 * away as soon as the note has text; "See all" opens the Examples page.
 */
export default function StartStrip() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { setValue, control } = useChatFormContext();
  const text = useWatch({ control, name: 'text' });
  const { data: examples } = useDiscoverExamples({ perField: 1 });
  const { data: datasets = [] } = useDiscoverDatasets();

  const suggestions = useMemo(() => pick(examples?.items ?? [], datasets), [examples, datasets]);

  if (text?.trim() || suggestions.length === 0) {
    return null;
  }

  const card =
    'flex items-center gap-2.5 rounded-xl border border-border-light bg-surface-primary p-2 text-left transition-colors hover:border-border-medium hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary';

  return (
    <div
      className="mx-auto mt-3 w-full max-w-3xl px-4 xl:max-w-4xl"
      aria-label={localize('com_discover_suggestions')}
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
        {suggestions.map((s) => {
          if (s.kind === 'example') {
            return (
              <a key={s.item.shareId} href={exampleShareUrl(s.item.shareId)} className={card}>
                <span className="flex size-11 flex-none overflow-hidden rounded-lg bg-white">
                  <img
                    src={exampleCoverUrl(s.item.shareId)}
                    alt=""
                    loading="lazy"
                    className="size-full object-contain"
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 text-[13px] font-medium leading-tight text-text-primary">
                    {s.item.title}
                  </span>
                  <span className="text-xs text-text-tertiary">
                    {localize('com_discover_example_label', { 0: s.item.field })}
                  </span>
                </span>
              </a>
            );
          }
          const Icon = fieldIcon(s.item.domain);
          return (
            <button
              key={`${s.item.pkg}:${s.item.name}`}
              type="button"
              className={card}
              onClick={() => setValue('text', datasetPrompt(s.item), { shouldValidate: true })}
            >
              <span className="flex size-11 flex-none items-center justify-center rounded-lg bg-surface-secondary text-text-secondary">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="line-clamp-2 text-[13px] font-medium leading-tight text-text-primary">
                  {localize('com_discover_explore_dataset', { 0: s.item.name })}
                </span>
                <span className="text-xs text-text-tertiary">
                  {localize('com_discover_dataset_label', { 0: s.item.pkg })}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-center">
        <button
          type="button"
          onClick={() => navigate('/examples')}
          className="rounded-md px-2 py-0.5 text-[13px] text-text-secondary hover:text-text-primary"
        >
          {localize('com_discover_see_all_examples')}
        </button>
      </div>
    </div>
  );
}
