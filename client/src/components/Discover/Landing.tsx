import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Mic, Plus, Sparkles } from 'lucide-react';
import { buildLoginRedirectUrl } from 'librechat-data-provider';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { DiscoverDataset } from '~/data-provider';
import { datasetPrompt, useDiscoverModels, useGetStartupConfig } from '~/data-provider';
import { useAuthContext, useDocumentTitle, useLocalize } from '~/hooks';
import ExamplesGallery from './ExamplesGallery';
import Footer from '~/components/Chat/Footer';
import DatasetsGrid from './DatasetsGrid';

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
  const { data: models } = useDiscoverModels();
  const [text, setText] = useState(params.get('prompt') ?? '');
  const [field, setField] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useDocumentTitle(startupConfig?.appTitle ?? 'OmicsBase');

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

  const model = models?.find((m) => m.default) ?? models?.[0];
  const loginUrl = (prompt?: string) =>
    buildLoginRedirectUrl('/c/new', prompt ? `?prompt=${encodeURIComponent(prompt)}` : '', '');

  const submit = () => {
    const prompt = text.trim();
    if (prompt) {
      navigate(loginUrl(prompt));
    }
  };

  const useDataset = (dataset: DiscoverDataset) => {
    setText(datasetPrompt(dataset));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    promptRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-presentation text-text-primary">
      <div className="omicsbase-aurora" aria-hidden="true">
        <div className="omicsbase-aurora-glow" />
        <div className="omicsbase-aurora-vignette" />
      </div>

      <div className="relative z-[1] mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-6">
        <header className="flex items-center justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <img src="assets/logo.svg" alt="" className="size-7" />
            <span
              className="inline-flex items-center gap-1.5 rounded-lg border border-border-light px-2.5 py-1 text-sm font-medium text-text-secondary"
              title={model?.description || undefined}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              {model?.label ?? localize('com_discover_model_unavailable')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={loginUrl()}
              className="rounded-full bg-text-primary px-3.5 py-1.5 text-sm font-medium text-surface-primary hover:opacity-90"
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

        <main className="flex flex-1 flex-col">
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

          <section className="mt-16" id="examples" aria-labelledby="examplesHeading">
            <h2 id="examplesHeading" className="mb-4 font-display text-xl font-medium">
              {localize('com_ui_examples')}
            </h2>
            <ExamplesGallery onFieldChange={setField} />
          </section>

          <section className="mt-14" id="datasets" aria-labelledby="datasetsHeading">
            <h2 id="datasetsHeading" className="mb-4 font-display text-xl font-medium">
              {localize('com_ui_datasets')}
            </h2>
            <DatasetsGrid field={field} onSelect={useDataset} />
          </section>
        </main>

        <div className="mt-16 pb-6">
          <Footer startupConfig={startupConfig} />
        </div>
      </div>
    </div>
  );
}
