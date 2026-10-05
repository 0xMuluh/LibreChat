import { useEffect, useState } from 'react';
import { ExternalLink, Microscope } from 'lucide-react';
import type { DiscoverStudy, DiscoverStudySource } from '~/data-provider';
import type { TranslationKeys } from '~/hooks';
import { studyPrompt, useDiscoverStudies } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const SOURCES: { value: DiscoverStudySource; label: string }[] = [
  { value: 'mgnify', label: 'MGnify' },
  { value: 'zenodo', label: 'Zenodo' },
];

const BIOMES: { value: string; label: TranslationKeys }[] = [
  { value: 'all', label: 'com_discover_biome_all' },
  { value: 'human-gut', label: 'com_discover_biome_human_gut' },
  { value: 'human-oral', label: 'com_discover_biome_human_oral' },
  { value: 'human-skin', label: 'com_discover_biome_human_skin' },
  { value: 'animal-gut', label: 'com_discover_biome_animal_gut' },
  { value: 'soil', label: 'com_discover_biome_soil' },
  { value: 'marine', label: 'com_discover_biome_marine' },
];

type Props = {
  /** Search text from the page's search box. */
  query?: string;
  onPrompt: (prompt: string) => void;
};

/** Public microbiome studies from MGnify and Zenodo, fetched live through the server. */
export default function OpenStudies({ query = '', onPrompt }: Props) {
  const localize = useLocalize();
  const [source, setSource] = useState<DiscoverStudySource>('mgnify');
  const [biome, setBiome] = useState('all');
  const [q, setQ] = useState('');

  /* Zenodo allows 30 requests a minute, so wait for typing to stop. */
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 500);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useDiscoverStudies({ source, biome, q });
  const studies = data?.pages.flatMap((p) => p.results) ?? [];
  const count = data?.pages[0]?.count ?? 0;

  const detail = (study: DiscoverStudy) => {
    if (study.source === 'MGnify') {
      const samples = localize('com_discover_study_samples', {
        0: (study.samples ?? 0).toLocaleString(),
      });
      return study.biome ? `${samples} · ${study.biome}` : samples;
    }
    return [
      study.year,
      study.license,
      study.files ? localize('com_discover_study_files', { 0: study.files }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };

  let emptyText = localize('com_discover_studies_empty');
  if (isError) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    emptyText = localize(
      status === 429 ? 'com_discover_studies_rate_limited' : 'com_discover_studies_error',
      { 0: source === 'zenodo' ? 'Zenodo' : 'MGnify' },
    );
  } else if (q) {
    emptyText = localize('com_discover_studies_no_match', { 0: q });
  }

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
      active
        ? 'border-transparent bg-accent-primary text-surface-primary'
        : 'border-border-medium text-text-secondary hover:bg-surface-hover',
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={localize('com_discover_filter_biome')}
        >
          {BIOMES.map((b) => (
            <button
              key={b.value}
              type="button"
              aria-pressed={biome === b.value}
              onClick={() => setBiome(b.value)}
              className={chip(biome === b.value)}
            >
              {localize(b.label)}
            </button>
          ))}
        </div>
        <div
          className="inline-flex rounded-lg border border-border-light bg-surface-secondary p-0.5"
          role="group"
          aria-label={localize('com_discover_filter_source')}
        >
          {SOURCES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={source === s.value}
              onClick={() => setSource(s.value)}
              className={cn(
                'rounded-md px-3 py-1 text-[13px] font-medium',
                source === s.value
                  ? 'bg-surface-primary text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:text-text-primary',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {studies.length > 0 && (
        <p className="text-xs text-text-tertiary">
          {localize('com_discover_studies_count', {
            0: studies.length,
            1: count.toLocaleString(),
          })}
        </p>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {studies.map((study) => (
          <div
            key={study.accession}
            className="flex items-start gap-3 rounded-xl border border-border-light bg-surface-primary p-3 transition-colors hover:border-border-heavy"
          >
            <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface-secondary text-text-secondary">
              <Microscope className="size-4" aria-hidden="true" />
            </span>
            <button
              type="button"
              onClick={() => onPrompt(studyPrompt(study))}
              title={study.name}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
            >
              <span className="line-clamp-2 text-[13px] font-medium leading-snug text-text-primary">
                {study.name}
              </span>
              <span className="text-xs text-text-secondary">{detail(study)}</span>
              <span className="font-mono text-xs text-text-tertiary">
                {study.source} · {study.accession}
              </span>
            </button>
            <a
              href={study.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={localize('com_discover_study_open', {
                0: study.accession,
                1: study.source,
              })}
              className="flex size-7 flex-none items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </div>
        ))}
      </div>

      {isLoading && (
        <p className="py-7 text-center text-sm text-text-tertiary">
          {localize('com_discover_studies_loading', {
            0: source === 'zenodo' ? 'Zenodo' : 'MGnify',
          })}
        </p>
      )}
      {!isLoading && !studies.length && (
        <p className="py-7 text-center text-sm text-text-tertiary">{emptyText}</p>
      )}

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-full border border-border-medium px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover disabled:opacity-50"
          >
            {localize(isFetchingNextPage ? 'com_discover_loading' : 'com_discover_load_more')}
          </button>
        </div>
      )}
    </div>
  );
}
