import type { FieldNode } from './fields';
import { useLocalize } from '~/hooks';
import { nodeText } from './fields';

/**
 * OmicsBase: what a node of the fields network covers, laid out like a menu
 * column — a marker, the title and a tagline, then items with a detail line.
 */
export default function NodeCard({ node }: { node: FieldNode }) {
  const localize = useLocalize();
  const text = nodeText(node);

  return (
    <section
      aria-labelledby="node-card-title"
      className="border-border-medium bg-surface-primary/80 flex h-97.5 flex-col rounded-2xl border p-6 shadow-lg backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="border-text-primary mt-0.5 flex size-8 flex-none items-center justify-center rounded-full border-2"
        >
          <svg viewBox="0 0 14 14" className="size-3.5">
            <circle cx="7" cy="7" r="7" fill={node.light} className="dark:hidden" />
            <circle cx="7" cy="7" r="7" fill={node.dark} className="hidden dark:block" />
          </svg>
        </span>
        <div>
          <h3 id="node-card-title" className="text-text-primary text-lg font-semibold">
            {localize(node.label)}
          </h3>
          <p className="text-text-secondary text-sm">{localize(text.tagline)}</p>
        </div>
      </div>
      <ul className="mt-5 grid flex-1 grid-cols-2 grid-rows-2 gap-3">
        {text.items.map((item) => (
          <li
            key={item.title}
            className="border-border-light bg-surface-secondary/60 flex flex-col justify-center rounded-xl border p-4"
          >
            <span className="text-text-primary text-1sm font-medium">{localize(item.title)}</span>
            <span className="text-text-secondary text-1xs mt-1 leading-snug">
              {localize(item.detail)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
