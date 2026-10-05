/* OmicsBase: public Examples, Datasets and model names (see api/server/routes/discover.js). */
import { useQuery } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';

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
};

export type DiscoverExamplesParams = {
  page?: number;
  pageSize?: number;
  field?: string;
  mode?: string;
  q?: string;
};

const BASE = '/api/discover';

export const exampleCoverUrl = (shareId: string) =>
  `${BASE}/examples/${encodeURIComponent(shareId)}/cover`;

export const exampleShareUrl = (shareId: string) => `/share/${encodeURIComponent(shareId)}`;

/** A starter prompt for a dataset: what a note asks first when a dataset is picked. */
export const datasetPrompt = (dataset: DiscoverDataset) =>
  `Load ${dataset.name} from ${dataset.pkg} and give me an overview of what it contains.`;

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

export function useDiscoverDatasets() {
  return useQuery<DiscoverDataset[]>({
    queryKey: ['discover', 'datasets'],
    queryFn: async () =>
      (await request.get<{ items: DiscoverDataset[] }>(`${BASE}/datasets`)).items,
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
