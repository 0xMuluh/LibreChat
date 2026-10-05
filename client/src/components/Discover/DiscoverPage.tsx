import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import { useDocumentTitle, useLocalize } from '~/hooks';
import { datasetPrompt } from '~/data-provider';
import ExamplesGallery from './ExamplesGallery';
import DatasetsGrid from './DatasetsGrid';
import SearchBox from './SearchBox';

/** OmicsBase: the signed-in Examples and Datasets pages. */
export default function DiscoverPage({ view }: { view: 'examples' | 'datasets' }) {
  const navigate = useNavigate();
  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const localize = useLocalize();
  const title = localize(view === 'examples' ? 'com_ui_examples' : 'com_ui_datasets');
  const [query, setQuery] = useState('');
  useDocumentTitle(title);

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-presentation text-text-primary">
      <header className="z-20 flex min-h-14 w-full flex-shrink-0 items-center gap-3 border-b border-border-light bg-presentation px-4 py-3 sm:px-5 md:px-6 lg:px-8">
        {isSmallScreen && <OpenSidebar />}
        <h1 className="text-base font-semibold">{title}</h1>
        <div className="ml-auto flex w-full max-w-sm justify-end">
          <SearchBox value={query} onChange={setQuery} />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-5 md:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          {view === 'examples' ? (
            <ExamplesGallery query={query} />
          ) : (
            <DatasetsGrid
              query={query}
              onSelect={(dataset) =>
                navigate(`/c/new?prompt=${encodeURIComponent(datasetPrompt(dataset))}`)
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const ExamplesPage = () => <DiscoverPage view="examples" />;
export const DatasetsPage = () => <DiscoverPage view="datasets" />;
