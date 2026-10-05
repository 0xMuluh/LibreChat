/* OmicsBase: public Examples, Datasets and model names (see api/server/routes/discover.js). */
import { request } from 'librechat-data-provider';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

export type DiscoverExample = {
  shareId: string;
  title: string;
  summary: string;
  field: string;
  dataset: string;
  source: string;
  prompt: string;
  mode: 'notes' | 'reports';
  hasCover: boolean;
  createdAt: string;
};

export type DiscoverExamplesPage = {
  items: DiscoverExample[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  fields: string[];
};

export type DiscoverDataset = {
  name: string;
  pkg: string;
  domain: string;
  species: string;
  cls: string;
  desc: string;
};

export type DiscoverModel = {
  name: string;
  label: string;
  description: string;
  default: boolean;
  endpoint: string | null;
  model: string | null;
  iconURL: string | null;
  endpointIconURL: string | null;
  providerId: string | null;
};

export type DiscoverStudySource = 'mgnify' | 'zenodo';

export type DiscoverStudy = {
  source: 'MGnify' | 'Zenodo';
  accession: string;
  name: string;
  url: string;
  /** MGnify */
  samples?: number;
  biome?: string;
  /** Zenodo */
  id?: string;
  year?: string;
  license?: string;
  files?: number;
};

export type DiscoverStudiesPage = {
  count: number;
  hasNext: boolean;
  results: DiscoverStudy[];
};

export type DiscoverExamplesParams = {
  page?: number;
  pageSize?: number;
  field?: string;
  mode?: string;
  q?: string;
  /** Up to this many examples with a cover from each field instead of a page. */
  perField?: number;
  /** Order for this visit; see `discoverSeed`. */
  seed?: number;
};

const BASE = '/api/discover';

export const exampleCoverUrl = (shareId: string) =>
  `${BASE}/examples/${encodeURIComponent(shareId)}/cover`;

export const exampleShareUrl = (shareId: string) => `/share/${encodeURIComponent(shareId)}`;

/** A starter prompt for a dataset: what a note asks first when a dataset is picked. */
export const datasetPrompt = (dataset: DiscoverDataset) =>
  `Load ${dataset.name} from ${dataset.pkg} and give me an overview of what it contains.`;

/**
 * A starter prompt for an open study. Whole MGnify studies take longer to fetch
 * than a cell may run, so the note starts from the metadata and a few analyses.
 */
export const studyPrompt = (study: DiscoverStudy) =>
  study.source === 'Zenodo'
    ? `Download the data files from Zenodo record ${study.id} (${study.name}), import the abundance table into a TreeSummarizedExperiment and give me an overview.`
    : `Use MGnifyR to look up MGnify study ${study.accession} (${study.name}). Show the sample metadata first, then fetch the taxonomic profiles for a small subset of its analyses and give me an overview of the samples and their composition.`;

/**
 * One random seed per browser session: the order is random on each visit and
 * stays the same while paging.
 */
export function discoverSeed(): number {
  const key = 'omicsbase:discover-seed';
  try {
    const saved = Number(sessionStorage.getItem(key));
    if (Number.isInteger(saved) && saved > 0) {
      return saved;
    }
    const seed = Math.floor(Math.random() * 2_147_483_646) + 1;
    sessionStorage.setItem(key, String(seed));
    return seed;
  } catch {
    return Math.floor(Date.now() / 86_400_000);
  }
}

export function useDiscoverExamples(params: DiscoverExamplesParams) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  });
  return useQuery<DiscoverExamplesPage>({
    queryKey: ['discover', 'examples', params],
    queryFn: () => request.get<DiscoverExamplesPage>(`${BASE}/examples?${search.toString()}`),
    keepPreviousData: true,
    staleTime: 60_000,
  });
}

export function useDiscoverDatasets(seed?: number) {
  const query = seed === undefined ? '' : `?seed=${seed}`;
  return useQuery<DiscoverDataset[]>({
    queryKey: ['discover', 'datasets', seed],
    queryFn: async () =>
      (await request.get<{ items: DiscoverDataset[] }>(`${BASE}/datasets${query}`)).items,
    staleTime: 3_600_000,
  });
}

export function useDiscoverModels() {
  return useQuery<DiscoverModel[]>({
    queryKey: ['discover', 'models'],
    queryFn: async () => (await request.get<{ items: DiscoverModel[] }>(`${BASE}/models`)).items,
    staleTime: 300_000,
  });
}

/** The deployment's own footer text, which the public startup config leaves out. */
export function useDiscoverFooter() {
  return useQuery<{ customFooter: string | null }>({
    queryKey: ['discover', 'footer'],
    queryFn: () => request.get<{ customFooter: string | null }>(`${BASE}/footer`),
    staleTime: 3_600_000,
  });
}

/** Open studies, a page of 12 at a time; `fetchNextPage` loads more. */
export function useDiscoverStudies(params: {
  source: DiscoverStudySource;
  biome: string;
  q: string;
  enabled?: boolean;
}) {
  const { source, biome, q, enabled = true } = params;
  return useInfiniteQuery<DiscoverStudiesPage>({
    queryKey: ['discover', 'studies', source, biome, q],
    queryFn: ({ pageParam = 1 }) => {
      const search = new URLSearchParams({ source, biome, page: String(pageParam) });
      if (q) {
        search.set('q', q);
      }
      return request.get<DiscoverStudiesPage>(`${BASE}/studies?${search.toString()}`);
    },
    getNextPageParam: (last, pages) => (last.hasNext ? pages.length + 1 : undefined),
    keepPreviousData: true,
    staleTime: 600_000,
    retry: false,
    enabled,
  });
}
