import { useEffect, useRef } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { Terminal, Table as TableIcon, Image as ImageIcon, Download, XCircle } from 'lucide-react';
import type { useRCell } from './useRCell';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { TERMINAL_STATUSES } from '~/data-provider/Notes/notesCellsApi';
import { useDownload } from './useDownload';
import { useLocalize } from '~/hooks';
import { BookRefs } from './BookRefs';
import { Files } from './Files';
import { cn } from '~/utils';

type OutputProps = Pick<
  ReturnType<typeof useRCell>,
  'execution' | 'stdout' | 'executionError' | 'authPlotUrls' | 'tables'
> & {
  /** Why a run ended early (stopped, cancelled, interrupted), shown above its output. */
  endingNotice?: string | null;
};

/** Lines of console shown while the cell is still running. */
const LIVE_CONSOLE_LINES = 40;

export function Output({
  execution,
  stdout,
  executionError,
  authPlotUrls,
  tables,
  endingNotice,
}: OutputProps) {
  const localize = useLocalize();
  const { download, pending } = useDownload();
  const isRunning = !!execution && !TERMINAL_STATUSES.has(execution.status);
  const consoleText = stdout ? String(stdout).trim() : '';
  const shownConsole = isRunning
    ? consoleText.split('\n').slice(-LIVE_CONSOLE_LINES).join('\n')
    : consoleText;
  const consoleRef = useRef<HTMLDivElement>(null);
  const files = (execution?.artifacts ?? []).filter(
    (artifact) => artifact.artifactType === 'file' && artifact.contentUrl,
  );

  useEffect(() => {
    if (isRunning && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [isRunning, shownConsole]);

  return (
    <>
      {(execution ||
        stdout ||
        executionError ||
        endingNotice ||
        authPlotUrls.length > 0 ||
        tables.length > 0 ||
        files.length > 0) && (
        <div className="border-border-light bg-surface-secondary/30 dark:border-border-heavy dark:bg-surface-secondary/10 border-t p-3">
          <div className="text-text-secondary text-2xs mb-2 flex items-center gap-1.5 font-medium">
            <Terminal className="size-3.5" />
            {localize('com_ui_note_output')}
          </div>

          {endingNotice && (
            <div
              data-testid="note-cell-ending"
              className="border-status-warning-border bg-status-warning-subtle text-status-warning mb-2.5 rounded-lg border p-3 text-xs"
            >
              {endingNotice}
            </div>
          )}

          {executionError && (
            <div className="border-status-error-border bg-status-error-subtle text-status-error mb-2.5 flex items-start gap-2.5 rounded-lg border p-3 text-xs">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 flex-1 overflow-x-auto">
                <div className="mb-1 font-semibold">{localize('com_ui_note_execution_error')}</div>
                <pre className="font-mono text-xs whitespace-pre-wrap">{executionError.trim()}</pre>
              </div>
            </div>
          )}

          {shownConsole && (
            <div
              ref={consoleRef}
              data-testid="note-cell-console"
              className={cn(
                'text-status-success-border dark:text-status-success mb-2.5 overflow-x-auto rounded-lg bg-black/90 p-3 font-mono text-xs',
                isRunning && 'max-h-64 overflow-y-auto',
              )}
            >
              <pre className="whitespace-pre-wrap">{shownConsole}</pre>
            </div>
          )}

          {tables.length > 0 && (
            <div className="mb-2.5 space-y-2">
              {tables.map((tbl, i) => (
                <div
                  key={i}
                  className="border-border-light bg-surface-primary dark:border-border-heavy rounded-lg border p-3"
                >
                  <div className="text-text-primary mb-1.5 flex items-center justify-between text-xs font-semibold">
                    <div className="flex items-center gap-2">
                      <TableIcon className="text-accent-primary size-3.5" />
                      <span>
                        {localize('com_ui_note_table_preview', { 0: tbl.rows, 1: tbl.cols })}
                      </span>
                    </div>
                    {tbl.url && (
                      <TooltipAnchor
                        description={localize('com_ui_note_download_file', { 0: tbl.file })}
                        side="top"
                        render={
                          <a
                            href={tbl.url}
                            download={tbl.file}
                            onClick={(event) => tbl.url && download(event, tbl.url, tbl.file)}
                            aria-busy={pending === tbl.url}
                            className="text-text-secondary hover:bg-surface-hover hover:text-text-primary inline-flex items-center gap-1 rounded p-1 text-xs transition-colors"
                            aria-label={localize('com_ui_note_download_file', { 0: tbl.file })}
                          >
                            <Download className="size-3.5" />
                          </a>
                        }
                      />
                    )}
                  </div>
                  <div className="markdown prose prose-sm max-w-none overflow-x-auto text-xs">
                    <MarkdownLite content={tbl.markdown} codeExecution={false} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {authPlotUrls.length > 0 && (
            <div className="space-y-3">
              {authPlotUrls.map((plotUrl, idx) => (
                <div
                  key={idx}
                  className="group border-border-light dark:border-border-heavy relative overflow-hidden rounded-xl border bg-white p-2 shadow-sm transition-all dark:bg-black"
                >
                  <div className="text-text-secondary mb-1.5 flex items-center justify-between px-1 text-xs">
                    <span className="flex items-center gap-1.5 font-medium">
                      <ImageIcon className="text-accent-primary size-3.5" />
                      {localize('com_ui_note_plot_title', { 0: idx + 1 })}
                    </span>
                    <TooltipAnchor
                      description={localize('com_ui_note_download_plot')}
                      side="top"
                      render={
                        <button
                          type="button"
                          onClick={() => {
                            const link = document.createElement('a');
                            link.href = plotUrl;
                            link.download = `plot_${idx + 1}.png`;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                          }}
                          className="text-text-secondary hover:bg-surface-hover hover:text-text-primary inline-flex items-center gap-1 rounded p-1 transition-colors"
                          aria-label={localize('com_ui_note_download_plot')}
                        >
                          <Download className="size-3.5" />
                        </button>
                      }
                    />
                  </div>
                  <img
                    src={plotUrl}
                    alt={localize('com_ui_note_plot_alt', { 0: idx + 1 })}
                    className="max-h-[500px] w-full rounded-lg object-contain"
                    loading="lazy"
                  />
                </div>
              ))}
            </div>
          )}

          <Files files={files} truncated={execution?.filesTruncated} />
          <BookRefs bookRefs={execution?.bookRefs} />
        </div>
      )}
    </>
  );
}
