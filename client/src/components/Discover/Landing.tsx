import { useEffect, useMemo, useRef, useState } from 'react';
import { buildLoginRedirectUrl } from 'librechat-data-provider';
import { ArrowUp, Database, LayoutGrid, Mic, Plus, SquarePen } from 'lucide-react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { DiscoverDataset, DiscoverModel } from '~/data-provider';
import {
  datasetPrompt,
  useDiscoverFooter,
  useDiscoverModels,
  useGetStartupConfig,
} from '~/data-provider';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import ExamplesGallery from './ExamplesGallery';
import Footer from '~/components/Chat/Footer';
import DatasetsGrid from './DatasetsGrid';
import ThemeToggle from './ThemeToggle';
import SearchBox from './SearchBox';
import ModelMenu from './ModelMenu';

/**
 * OmicsBase: the page a signed-out visitor sees at /welcome. A question typed
 * here survives sign-in and opens as a new note.
 */
export default function Landing() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { isAuthenticated } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: footer } = useDiscoverFooter();
  const { data: models } = useDiscoverModels();
  const [text, setText] = useState(params.get('prompt') ?? '');
  const [field, setField] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<DiscoverModel | undefined>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useDocumentTitle(startupConfig?.appTitle ?? 'OmicsBase');

  /* The public startup config leaves out the deployment's own footer text. */
  const footerConfig = useMemo(
    () =>
      startupConfig
        ? { ...startupConfig, customFooter: footer?.customFooter ?? startupConfig.customFooter }
        : startupConfig,
    [startupConfig, footer],
  );

  useEffect(() => {
    const el = promptRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  if (isAuthenticated) {
    return <Navigate to={`/c/new${location.search}`} replace />;
  }

  const model = chosen ?? models?.find((m) => m.default) ?? models?.[0];
  /** After sign-in, open a new note with the chosen model and the question, if any. */
  const loginUrl = (prompt?: string) => {
    const next = new URLSearchParams();
    if (chosen) {
      next.set('spec', chosen.name);
    }
    if (prompt) {
      next.set('prompt', prompt);
    }
    const search = next.toString();
    return buildLoginRedirectUrl('/c/new', search ? `?${search}` : '', '');
  };

  const submit = () => {
    const prompt = text.trim();
    if (prompt) {
      navigate(loginUrl(prompt));
    }
  };

  const goTo = (id: string) => {
    if (id === 'top') {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      promptRef.current?.focus({ preventScroll: true });
      return;
    }
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const useDataset = (dataset: DiscoverDataset) => {
    setText(datasetPrompt(dataset));
    goTo('top');
  };

  const navItem =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary';

  return (
    <div className="relative flex h-screen overflow-hidden bg-presentation text-text-primary">
      <div className="omicsbase-aurora" aria-hidden="true">
        <div className="omicsbase-aurora-glow" />
        <div className="omicsbase-aurora-vignette" />
      </div>

      <aside
        className="relative z-[1] hidden w-64 flex-none flex-col border-r border-border-light bg-surface-primary-alt p-3 md:flex"
        aria-label={localize('com_discover_sidebar')}
      >
        <div className="flex items-center gap-2 px-1.5 pb-4 pt-1">
          <img src="assets/logo.svg" alt="" className="size-6" />
          <span className="font-display text-base font-medium">
            {startupConfig?.appTitle ?? 'OmicsBase'}
          </span>
        </div>
        <nav className="flex flex-col gap-0.5">
          <button type="button" className={navItem} onClick={() => goTo('top')}>
            <SquarePen className="size-4" aria-hidden="true" />
            {localize('com_discover_new_note')}
          </button>
          <button type="button" className={navItem} onClick={() => goTo('examples')}>
            <LayoutGrid className="size-4" aria-hidden="true" />
            {localize('com_ui_examples')}
          </button>
          <button type="button" className={navItem} onClick={() => goTo('datasets')}>
            <Database className="size-4" aria-hidden="true" />
            {localize('com_ui_datasets')}
          </button>
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-1.5 pb-1">
          <p className="text-[13px] leading-snug text-text-secondary">
            {localize('com_discover_sidebar_login_hint')}
          </p>
          <a
            href={loginUrl()}
            className="rounded-full border border-border-medium px-3 py-1.5 text-center text-sm font-medium text-text-primary hover:bg-surface-hover"
          >
            {localize('com_discover_log_in')}
          </a>
        </div>
      </aside>

      <div className="relative z-[1] min-w-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto">
          <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-presentation/80 px-3 py-2.5 backdrop-blur sm:px-4">
            <ModelMenu models={models ?? []} selected={model} onSelect={setChosen} />
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <a
                href={loginUrl()}
                className="rounded-full bg-accent-primary px-3.5 py-1.5 text-sm font-medium text-surface-primary hover:bg-accent-primary-hover"
              >
                {localize('com_discover_log_in')}
              </a>
              <a
                href={loginUrl()}
                className="rounded-full border border-border-medium px-3.5 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover"
              >
                {localize('com_discover_sign_up')}
              </a>
            </div>
          </header>
          <div className="mx-auto flex max-w-6xl flex-col px-4 pb-16 sm:px-6">
            <main className="flex flex-col">
              <section className="mx-auto mt-[9vh] w-full max-w-3xl text-center">
                <h1 className="mb-6 font-display text-3xl font-medium tracking-tight sm:text-4xl">
                  {localize('com_discover_hero')}
                </h1>
                <form
                  className="flex items-end gap-2 rounded-3xl border border-border-light bg-surface-chat p-2.5 shadow-sm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  <a
                    href={loginUrl()}
                    aria-label={localize('com_discover_add_data')}
                    title={localize('com_discover_log_in_to_add_data')}
                    className="flex size-9 flex-none items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover"
                  >
                    <Plus className="size-5" aria-hidden="true" />
                  </a>
                  <textarea
                    ref={promptRef}
                    rows={1}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    placeholder={localize('com_discover_prompt_placeholder')}
                    aria-label={localize('com_discover_message')}
                    className="max-h-[200px] flex-1 resize-none bg-transparent py-2 text-base text-text-primary outline-none placeholder:text-text-tertiary"
                  />
                  <a
                    href={loginUrl()}
                    aria-label={localize('com_discover_voice_input')}
                    title={localize('com_discover_log_in_to_use_voice')}
                    className="flex size-9 flex-none items-center justify-center rounded-full text-text-secondary hover:bg-surface-hover"
                  >
                    <Mic className="size-5" aria-hidden="true" />
                  </a>
                  <button
                    type="submit"
                    aria-label={localize('com_discover_send')}
                    disabled={!text.trim()}
                    className="flex size-9 flex-none items-center justify-center rounded-full bg-text-primary text-surface-primary disabled:opacity-30"
                  >
                    <ArrowUp className="size-5" aria-hidden="true" />
                  </button>
                </form>
              </section>

              <section
                className="mt-16 scroll-mt-4"
                id="examples"
                aria-labelledby="examplesHeading"
              >
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <h2 id="examplesHeading" className="font-display text-xl font-medium">
                    {localize('com_ui_examples')}
                  </h2>
                  <SearchBox value={query} onChange={setQuery} />
                </div>
                <ExamplesGallery onFieldChange={setField} query={query} />
              </section>

              <section
                className="mt-14 scroll-mt-4"
                id="datasets"
                aria-labelledby="datasetsHeading"
              >
                <h2 id="datasetsHeading" className="mb-4 font-display text-xl font-medium">
                  {localize('com_ui_datasets')}
                </h2>
                <DatasetsGrid field={field} query={query} onSelect={useDataset} />
              </section>
            </main>
          </div>
        </div>
        {/* Pinned to the bottom of the page, as in the signed-in app. */}
        <div className="absolute bottom-0 left-0 right-0">
          <Footer
            startupConfig={footerConfig}
            className="hidden items-center justify-center gap-2 bg-presentation px-2 py-2 text-center text-xs text-text-muted sm:flex md:px-[60px]"
          />
        </div>
      </div>
    </div>
  );
}
