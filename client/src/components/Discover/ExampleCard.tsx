import { memo } from 'react';
import type { DiscoverExample } from '~/data-provider';
import { exampleCoverUrl, exampleShareUrl } from '~/data-provider';
import Placeholder from './Placeholder';
import { useLocalize } from '~/hooks';

function ExampleCard({ example }: { example: DiscoverExample }) {
  const localize = useLocalize();
  const meta = [example.dataset, example.source].filter(Boolean).join(' · ');
  return (
    <a
      href={exampleShareUrl(example.shareId)}
      className="group flex flex-col overflow-hidden rounded-xl border border-border-light bg-surface-primary text-left transition-colors hover:border-border-heavy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
    >
      <div className="relative aspect-video border-b border-border-light bg-white">
        {example.hasCover ? (
          <img
            src={exampleCoverUrl(example.shareId)}
            alt=""
            loading="lazy"
            className="absolute inset-1.5 h-[calc(100%-0.75rem)] w-[calc(100%-0.75rem)] object-contain"
          />
        ) : (
          <div className="h-full bg-surface-secondary p-3">
            <Placeholder seed={example.shareId} />
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-3.5 pb-3.5 pt-3">
        <span className="text-sm font-semibold text-text-primary">{example.title}</span>
        {example.summary && (
          <span className="flex-1 text-[13px] leading-snug text-text-secondary">
            {example.summary}
          </span>
        )}
        <span className="mt-1 flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-text-tertiary" title={meta}>
            {meta || example.field}
          </span>
          <span className="flex-none rounded-full bg-surface-tertiary px-2.5 py-0.5 text-xs font-medium text-accent-primary group-hover:bg-surface-active-alt">
            {localize(
              example.mode === 'reports' ? 'com_discover_read_report' : 'com_discover_explore',
            )}
          </span>
        </span>
      </div>
    </a>
  );
}

export default memo(ExampleCard);
