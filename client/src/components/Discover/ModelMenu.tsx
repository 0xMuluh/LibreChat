import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import type { TEndpointsConfig, TModelSpec } from 'librechat-data-provider';
import type { DiscoverModel } from '~/data-provider';
import SpecDescription from '~/components/Chat/Menus/Endpoints/components/SpecDescription';
import SpecIcon from '~/components/Chat/Menus/Endpoints/components/SpecIcon';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type Props = {
  models: DiscoverModel[];
  selected?: DiscoverModel;
  onSelect: (model: DiscoverModel) => void;
};

/** The spec shape the signed-in picker's icon reads. */
const toSpec = (model: DiscoverModel) =>
  ({
    name: model.name,
    label: model.label,
    iconURL: model.iconURL ?? undefined,
    preset: { endpoint: model.endpoint ?? undefined, model: model.model ?? undefined },
  }) as TModelSpec;

/**
 * The model picker as signed-in users see it, with the same provider logos;
 * the choice carries into the first note.
 */
export default function ModelMenu({ models, selected, onSelect }: Props) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  /** Just enough endpoint config for the logos: provider and icon per endpoint. */
  const endpointsConfig = useMemo(
    () =>
      Object.fromEntries(
        models
          .filter((m) => m.endpoint)
          .map((m) => [m.endpoint, { providerId: m.providerId, iconURL: m.endpointIconURL }]),
      ) as TEndpointsConfig,
    [models],
  );

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

  const trigger =
    'my-1 flex h-9 max-w-full items-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt';

  if (!models.length) {
    return (
      <span className={cn(trigger, 'text-text-tertiary hover:bg-presentation')}>
        <Sparkles className="size-4" aria-hidden="true" />
        {localize('com_discover_model_unavailable')}
      </span>
    );
  }

  return (
    <div className="relative min-w-0 max-w-[60vw] sm:max-w-xs" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={localize('com_ui_select_model')}
        onClick={() => setOpen((v) => !v)}
        className={trigger}
      >
        {selected && (
          <span className="flex flex-shrink-0 items-center justify-center overflow-hidden">
            <SpecIcon currentSpec={toSpec(selected)} endpointsConfig={endpointsConfig} />
          </span>
        )}
        <span className="truncate text-left">{selected?.label}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={localize('com_discover_models')}
          className="animate-popover absolute left-0 top-full z-40 mt-1 flex max-h-[min(450px,65vh)] w-max min-w-[300px] max-w-[calc(100vw-4rem)] flex-col overflow-auto rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary shadow-lg sm:max-w-[400px]"
        >
          {models.map((model) => {
            const isSelected = model.name === selected?.name;
            return (
              <button
                key={model.name}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onSelect(model);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary"
              >
                <span
                  className={cn(
                    'flex w-full min-w-0 gap-2 px-1 py-1',
                    model.description ? 'items-start' : 'items-center',
                  )}
                >
                  <span className="flex-shrink-0">
                    <SpecIcon currentSpec={toSpec(model)} endpointsConfig={endpointsConfig} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate">{model.label}</span>
                    <SpecDescription description={model.description} />
                  </span>
                </span>
                {isSelected && (
                  <CheckCircle2
                    className="size-4 shrink-0 self-center text-text-primary"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
