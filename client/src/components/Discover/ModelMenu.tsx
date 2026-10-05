import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Sparkles } from 'lucide-react';
import type { DiscoverModel } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Props = {
  models: DiscoverModel[];
  selected?: DiscoverModel;
  onSelect: (model: DiscoverModel) => void;
};

/** The model picker as signed-in users see it; the choice carries into the first note. */
export default function ModelMenu({ models, selected, onSelect }: Props) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === 'Escape'
          : !rootRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!models.length) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border-light px-2.5 py-1 text-sm font-medium text-text-tertiary">
        <Sparkles className="size-4" aria-hidden="true" />
        {localize('com_discover_model_unavailable')}
      </span>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-light px-2.5 py-1 text-sm font-medium text-text-primary hover:bg-surface-hover"
      >
        <Sparkles className="size-4 text-accent-primary" aria-hidden="true" />
        {selected?.label}
        <ChevronDown className="size-3.5 text-text-tertiary" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={localize('com_discover_models')}
          className="absolute left-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-border-light bg-surface-primary p-1 shadow-lg"
        >
          {models.map((model) => (
            <button
              key={model.name}
              type="button"
              role="option"
              aria-selected={model.name === selected?.name}
              onClick={() => {
                onSelect(model);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover',
                model.name === selected?.name && 'bg-surface-secondary',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium text-text-primary">{model.label}</span>
                {model.description && (
                  <span className="text-xs text-text-tertiary">{model.description}</span>
                )}
              </span>
              {model.name === selected?.name && (
                <Check className="mt-0.5 size-4 flex-none text-accent-primary" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
