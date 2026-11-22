import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DiscoverModel } from '~/data-provider';
import ExamplesGallery from '../ExamplesGallery';
import DatasetsGrid from '../DatasetsGrid';
import ModelMenu from '../ModelMenu';

const mockExamples = jest.fn();
const mockDatasets = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(',')}` : key,
}));

jest.mock('~/data-provider', () => ({
  discoverSeed: () => 1,
  datasetPrompt: () => '',
  useGetStartupConfig: () => ({ data: undefined }),
  useDiscoverExamples: () => mockExamples(),
  useDiscoverDatasets: () => mockDatasets(),
}));

jest.mock('@librechat/client', () => ({ useMediaQuery: () => false }));
jest.mock('../FieldCarousel', () =>
  jest.requireActual('react').forwardRef(() => <section data-testid="carousel" />),
);
jest.mock('../FieldNetwork', () => () => null);
jest.mock('../FieldChips', () => () => null);
jest.mock('../NodeCard', () => () => null);
jest.mock('../OpenStudies', () => () => null);
jest.mock('~/components/Chat/Menus/Endpoints/components/SpecDescription', () => () => null);
jest.mock('~/components/Chat/Menus/Endpoints/components/SpecIcon', () => () => null);

beforeAll(() => {
  window.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

const query = (overrides: Record<string, unknown>) => ({
  data: undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: jest.fn(),
  ...overrides,
});

describe('ExamplesGallery states outside search', () => {
  it('says the examples are loading', () => {
    mockExamples.mockReturnValue(query({ isLoading: true }));
    render(<ExamplesGallery />);
    expect(screen.getByText('com_discover_examples_loading')).toBeInTheDocument();
  });

  it('shows the error with a Try again button that refetches', () => {
    const refetch = jest.fn();
    mockExamples.mockReturnValue(query({ isError: true, refetch }));
    render(<ExamplesGallery />);
    expect(screen.getByText('com_discover_examples_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_discover_try_again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('says the install has no examples when there are none', () => {
    mockExamples.mockReturnValue(
      query({ data: { items: [], total: 0, page: 1, pages: 1, pageSize: 1, fields: [] } }),
    );
    render(<ExamplesGallery />);
    expect(screen.getByText('com_discover_examples_none')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_discover_try_again' })).toBeNull();
  });

  it('draws the field rows and no status line when examples exist', () => {
    mockExamples.mockReturnValue(
      query({
        data: { items: [], total: 3, page: 1, pages: 3, pageSize: 1, fields: ['Microbiome'] },
      }),
    );
    render(<ExamplesGallery />);
    expect(screen.getAllByTestId('carousel').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('DatasetsGrid built-in states', () => {
  it('says the datasets are loading', () => {
    mockDatasets.mockReturnValue(query({ isLoading: true }));
    render(<DatasetsGrid onPrompt={jest.fn()} />);
    expect(screen.getByText('com_discover_datasets_loading')).toBeInTheDocument();
  });

  it('shows the error with a Try again button that refetches', () => {
    const refetch = jest.fn();
    mockDatasets.mockReturnValue(query({ isError: true, refetch }));
    render(<DatasetsGrid onPrompt={jest.fn()} />);
    expect(screen.getByText('com_discover_datasets_error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_discover_try_again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('ModelMenu states', () => {
  const model: DiscoverModel = {
    name: 'm',
    label: 'Model M',
    description: '',
    default: true,
    endpoint: null,
    model: null,
    iconURL: null,
    endpointIconURL: null,
    providerId: null,
  };

  it('says the models are loading', () => {
    render(<ModelMenu loading onSelect={jest.fn()} />);
    expect(screen.getByText('com_discover_model_loading')).toBeInTheDocument();
  });

  it('points to sign-in when the install lists no models', () => {
    render(<ModelMenu models={[]} onSelect={jest.fn()} />);
    expect(screen.getByText('com_discover_model_after_login')).toBeInTheDocument();
  });

  it('says Unavailable only when the list could not be loaded', () => {
    render(<ModelMenu onSelect={jest.fn()} />);
    expect(screen.getByText('com_discover_model_unavailable')).toBeInTheDocument();
  });

  it('shows the chosen model once loaded', () => {
    render(<ModelMenu models={[model]} selected={model} onSelect={jest.fn()} />);
    expect(screen.getByText('Model M')).toBeInTheDocument();
  });
});
