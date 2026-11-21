import type { FieldNode } from './fields';
import { useLocalize } from '~/hooks';
import { nodeShort } from './fields';
import { cn } from '~/utils';

type Props = {
  nodes: FieldNode[];
  selected: string;
  onSelect: (id: string) => void;
  localReports?: boolean;
};

/** OmicsBase: the network's fields as one row of buttons, for screens too narrow for the network. */
export default function FieldChips({ nodes, selected, onSelect, localReports = false }: Props) {
  const localize = useLocalize();
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      role="group"
      aria-label={localize('com_discover_filter_field')}
    >
      {nodes.map((n) => (
        <button
          key={n.id}
          type="button"
          aria-pressed={selected === n.id}
          onClick={() => onSelect(selected === n.id ? '' : n.id)}
          className={cn(
            'flex flex-none items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap',
            selected === n.id
              ? 'border-border-heavy bg-surface-active text-text-primary'
              : 'border-border-light bg-surface-primary/70 text-text-secondary hover:text-text-primary',
          )}
        >
          {/* The field's colour, drawn as the carousels draw it. */}
          {(
            [
              [n.light, 'dark:hidden'],
              [n.dark, 'hidden dark:block'],
            ] as const
          ).map(([colour, show]) => (
            <svg
              key={show}
              className={cn('size-2 flex-none', show)}
              viewBox="0 0 8 8"
              aria-hidden="true"
            >
              <circle cx="4" cy="4" r="4" fill={colour} />
            </svg>
          ))}
          {localize(nodeShort(n, localReports))}
        </button>
      ))}
    </div>
  );
}
