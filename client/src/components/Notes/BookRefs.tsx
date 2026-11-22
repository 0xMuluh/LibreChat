import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import type { NoteBookRef, NoteBookRefs } from '~/data-provider/Notes/notesCellsApi';

const linkClass =
  'rounded underline decoration-dotted underline-offset-2 hover:text-text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-heavy';

function sectionLabel(ref: NoteBookRef, withHeading = false): string {
  const parts = [ref.book_short, ref.chapter];
  if (withHeading && ref.heading && ref.heading !== ref.chapter) {
    parts.push(ref.heading);
  }
  return parts.join(' › ');
}

function SectionLink({ bookRef, withHeading }: { bookRef: NoteBookRef; withHeading?: boolean }) {
  const localize = useLocalize();
  const label = sectionLabel(bookRef, withHeading);
  return (
    <a
      href={bookRef.url}
      target="_blank"
      rel="noreferrer"
      className={linkClass}
      aria-label={localize('com_ui_note_book_link_aria', { 0: label })}
    >
      {label}
    </a>
  );
}

/** One muted line under a cell's output: where the books use its analysis functions. */
export function BookRefs({ bookRefs }: { bookRefs?: NoteBookRefs | null }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  if (!bookRefs) {
    return null;
  }
  const { refs, missing, book_versions: versions } = bookRefs;
  const shown = bookRefs.status === 'from_book' ? bookRefs.shown : null;
  if (!shown && missing.length === 0) {
    return null;
  }

  const others = refs.filter(
    (ref) => !(shown && ref.url === shown.url && ref.function === shown.function),
  );
  const byFunction = new Map<string, NoteBookRef[]>();
  for (const ref of others) {
    byFunction.set(ref.function, [...(byFunction.get(ref.function) ?? []), ref]);
  }
  const shortNames = new Map(refs.map((ref) => [ref.book, ref.book_short]));
  const versionText = Object.entries(versions)
    .map(([slug, version]) => `${shortNames.get(slug) ?? slug} ${version}`)
    .join(', ');
  const hasDetails = byFunction.size > 0 || (shown != null && versionText !== '');

  const shownFunctions = shown
    ? Array.from(
        new Set([
          shown.function,
          ...refs.filter((ref) => ref.url === shown.url).map((ref) => ref.function),
        ]),
      ).join(', ')
    : '';

  return (
    <div className="text-text-tertiary text-2xs mt-2.5" data-testid="note-cell-book-refs">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {shown ? (
          <>
            <span>{localize('com_ui_note_from_book')}</span>
            <span aria-hidden="true">·</span>
            <TooltipAnchor
              description={localize('com_ui_note_from_book_tooltip', { 0: shownFunctions })}
              side="top"
              render={
                <a
                  href={shown.url}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                  aria-label={localize('com_ui_note_book_link_aria', { 0: sectionLabel(shown) })}
                >
                  {sectionLabel(shown)}
                </a>
              }
            />
          </>
        ) : (
          <span>
            {localize('com_ui_note_not_in_books', {
              0: missing.map((fn) => `${fn.function}()`).join(', '),
            })}
          </span>
        )}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={localize('com_ui_note_book_more')}
            className="hover:bg-surface-hover hover:text-text-primary focus-visible:outline-border-heavy inline-flex size-4 items-center justify-center rounded focus-visible:outline focus-visible:outline-1"
          >
            <ChevronDown
              className={cn('size-3 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {hasDetails && open && (
        <div id={detailsId} className="mt-1 space-y-0.5">
          {byFunction.size > 0 && (
            <ul className="space-y-0.5">
              {Array.from(byFunction, ([fn, fnRefs]) => (
                <li key={fn} className="flex flex-wrap gap-x-1.5">
                  <span className="font-mono">{fn}()</span>
                  {fnRefs.map((ref, i) => (
                    <SectionLink key={`${ref.url}-${i}`} bookRef={ref} withHeading />
                  ))}
                </li>
              ))}
            </ul>
          )}
          {versionText && <div>{localize('com_ui_note_book_versions', { 0: versionText })}</div>}
        </div>
      )}
    </div>
  );
}
