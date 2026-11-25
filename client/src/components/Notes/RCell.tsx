import React, { useMemo } from 'react';
import Editor from '@monaco-editor/react';
import { TooltipAnchor, disabledFillClasses } from '@librechat/client';
import {
  Play,
  Pencil,
  Eye,
  Copy,
  Check,
  Terminal,
  Table as TableIcon,
  Image as ImageIcon,
  Loader2,
  Save,
  Square,
  History,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Download,
} from 'lucide-react';
import type { RCellBlockProps } from './types';
import type { TranslationKeys } from '~/hooks';
import useLazyHighlight from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import { useMessageContext, useShareContext } from '~/Providers';
import { statusLabel, statusTone, statusIcon } from './status';
import { StatusLine, endingNotice } from './StatusLine';
import { noteConversationId } from './conversation';
import { useRCell } from './useRCell';
import { useLocalize } from '~/hooks';
import { Output } from './Output';
import { cn } from '~/utils';

function saveTooltipKey(isDirty: boolean, isSaving: boolean): TranslationKeys {
  if (isDirty) {
    return 'com_ui_note_save_revision';
  }
  return isSaving ? 'com_ui_note_saving' : 'com_ui_note_save_none';
}

function runBlockedKey(isDirty: boolean, hasCell: boolean, hasCode: boolean): TranslationKeys {
  if (isDirty) {
    return 'com_ui_note_run_unsaved';
  }
  if (!hasCell) {
    return 'com_ui_note_run_binding';
  }
  return hasCode ? 'com_ui_note_run_blocked' : 'com_ui_note_run_empty';
}

export default function RCell(props: RCellBlockProps) {
  const localize = useLocalize();
  const { conversationId: messageConvoId, messageId } = useMessageContext();
  const share = useShareContext();
  const { isSharedConvo } = share;
  const conversationId = noteConversationId(messageConvoId, share);
  const { isAgentGenerated } = props;
  const {
    handleSelectHistory,
    code,
    isEditing,
    setIsEditing,
    isCopied,
    isSaving,
    isBootstrapping,
    execution,
    history,
    showHistory,
    setShowHistory,
    authPlotUrls,
    tables,
    isDirty,
    execStatus,
    isActive,
    cellId,
    handleCodeChange,
    handleCopy,
    handleSave,
    handleRun,
    handleCancel,
    executionError,
    stdout,
  } = useRCell(props, conversationId, messageId);
  const highlighted = useLazyHighlight(code || '# (Preparing R cell...)', 'r');

  const runDisabled =
    !!isSharedConvo ||
    !cellId ||
    isDirty ||
    isActive ||
    isBootstrapping ||
    !code.trim() ||
    !conversationId ||
    conversationId === 'new';

  const runTooltipKey: TranslationKeys = runDisabled
    ? runBlockedKey(isDirty, !!cellId, !!code.trim())
    : 'com_ui_note_run';

  const containerStatusClass = useMemo(() => {
    if (isActive) {
      return 'border-status-info/50 ring-1 ring-status-info/30 shadow-md';
    }
    if (execStatus === 'failed') {
      return 'border-status-error/50 ring-1 ring-status-error/20 shadow-sm';
    }
    if (execStatus === 'queued') {
      return 'border-status-warning/50 ring-1 ring-status-warning/20 shadow-sm';
    }
    return 'border-border-light dark:border-border-heavy shadow-sm';
  }, [isActive, execStatus]);

  const headerStatusBg = useMemo(() => {
    if (isActive) {
      return 'border-status-info/20 bg-status-info/10';
    }
    if (execStatus === 'failed') {
      return 'border-status-error/20 bg-status-error/10';
    }
    return 'border-border-light bg-surface-secondary/60 dark:border-border-heavy dark:bg-surface-secondary/30';
  }, [isActive, execStatus]);

  return (
    <div
      className={cn(
        'bg-surface-primary my-3 w-full overflow-hidden rounded-xl border transition-all',
        containerStatusClass,
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs backdrop-blur-sm',
          headerStatusBg,
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="border-accent-primary/30 bg-accent-primary/10 text-accent-primary text-2xs inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono font-semibold">
            <span className="bg-accent-primary size-1.5 animate-pulse rounded-full" />
            {'<R>'}
          </span>
          {isAgentGenerated && (
            <span className="text-text-tertiary hidden items-center gap-1 font-medium sm:inline-flex">
              OB
            </span>
          )}
          {execution?.attempt && execution.attempt > 1 && (
            <TooltipAnchor
              description={localize('com_ui_note_revision_attempt', { 0: execution.attempt })}
              side="top"
              render={
                <span className="bg-accent-primary/10 text-accent-primary text-3xs cursor-default rounded px-1.5 py-0.5 font-mono font-semibold">
                  {localize('com_ui_note_revision_badge', { 0: execution.attempt })}
                </span>
              }
            />
          )}
          {history.length > 1 && execution && history[0]?.id && execution.id !== history[0].id && (
            <TooltipAnchor
              description={localize('com_ui_note_superseded_tooltip')}
              side="top"
              render={
                <span className="bg-text-tertiary/15 text-text-tertiary text-3xs cursor-default rounded px-1.5 py-0.5 font-medium">
                  {localize('com_ui_note_superseded')}
                </span>
              }
            />
          )}
          <StatusLine execution={execution} isLoading={isBootstrapping} />
          {isDirty && (
            <TooltipAnchor
              description={localize('com_ui_note_unsaved_tooltip')}
              side="top"
              render={
                <span className="bg-status-warning/15 text-status-warning text-3xs cursor-default rounded px-1.5 py-0.5 font-semibold">
                  {localize('com_ui_note_unsaved')}
                </span>
              }
            />
          )}
        </div>

        <div className="flex items-center gap-1">
          {!isSharedConvo && (
            <TooltipAnchor
              description={localize(isEditing ? 'com_ui_note_view_code' : 'com_ui_note_edit_code')}
              side="top"
              render={
                <button
                  type="button"
                  onClick={() => setIsEditing((prev) => !prev)}
                  className={cn(
                    'text-text-secondary hover:bg-surface-hover hover:text-text-primary inline-flex size-7 items-center justify-center rounded-md transition-colors',
                    isEditing && 'bg-surface-hover text-text-primary',
                  )}
                  aria-label={localize(
                    isEditing ? 'com_ui_note_preview_code' : 'com_ui_note_edit_code',
                  )}
                >
                  {isEditing ? <Eye className="size-4" /> : <Pencil className="size-4" />}
                </button>
              }
            />
          )}

          <TooltipAnchor
            description={localize(isCopied ? 'com_ui_note_copied' : 'com_ui_note_copy_code')}
            side="top"
            render={
              <button
                type="button"
                onClick={handleCopy}
                className="text-text-secondary hover:bg-surface-hover hover:text-text-primary inline-flex size-7 items-center justify-center rounded-md transition-colors"
                aria-label={localize('com_ui_note_copy_code')}
              >
                {isCopied ? (
                  <Check className="text-status-success size-4" />
                ) : (
                  <Copy className="size-4" />
                )}
              </button>
            }
          />

          <TooltipAnchor
            description={localize(saveTooltipKey(isDirty, isSaving))}
            side="top"
            render={
              <button
                type="button"
                onClick={handleSave}
                disabled={!isDirty || isSaving || !cellId}
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md transition-colors',
                  isDirty
                    ? 'bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 active:scale-95'
                    : 'text-text-tertiary cursor-not-allowed opacity-50',
                )}
                aria-label={localize('com_ui_note_save_revision_aria')}
              >
                {isSaving ? (
                  <Loader2 className="text-accent-primary size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
              </button>
            }
          />

          {history.length > 0 && (
            <TooltipAnchor
              description={localize('com_ui_note_history')}
              side="top"
              render={
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className={cn(
                    'hover:bg-surface-hover inline-flex size-7 items-center justify-center rounded-md transition-colors',
                    showHistory ? 'bg-surface-hover text-text-primary' : 'text-text-secondary',
                  )}
                  aria-label={localize('com_ui_note_history')}
                >
                  <History className="size-4" />
                </button>
              }
            />
          )}

          {!isSharedConvo &&
            (isActive ? (
              <TooltipAnchor
                description={localize('com_ui_note_cancel_run')}
                side="top"
                render={
                  <button
                    type="button"
                    onClick={handleCancel}
                    disabled={!!execution?.cancelRequested}
                    className={cn(
                      'bg-status-neutral text-text-inverted hover:bg-status-neutral/80 inline-flex size-7 items-center justify-center rounded-md shadow-sm transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-50',
                      disabledFillClasses,
                    )}
                    aria-label={localize('com_ui_note_cancel_run')}
                  >
                    <Square className="size-3.5 fill-current" />
                  </button>
                }
              />
            ) : (
              <TooltipAnchor
                description={localize(runTooltipKey)}
                side="top"
                render={
                  <button
                    type="button"
                    onClick={handleRun}
                    disabled={runDisabled}
                    className={cn(
                      'inline-flex size-7 items-center justify-center rounded-md transition-all',
                      runDisabled
                        ? 'bg-surface-submit/30 text-text-on-status/50 cursor-not-allowed'
                        : 'bg-surface-submit text-text-on-status hover:bg-surface-submit-hover shadow-sm active:scale-95',
                    )}
                    aria-label={localize('com_ui_note_run')}
                  >
                    <Play className="size-3.5 fill-current" />
                  </button>
                }
              />
            ))}
        </div>
      </div>

      <div className="bg-transparent p-2">
        {isEditing ? (
          <div className="border-border-light/40 min-h-[120px] overflow-hidden rounded-lg border">
            <Editor
              height="200px"
              defaultLanguage="r"
              value={code}
              onChange={(value) => handleCodeChange(value || '')}
              theme="vs-dark"
              beforeMount={(monaco) => {
                monaco.editor.defineTheme('ob-code-dark', {
                  base: 'vs-dark',
                  inherit: true,
                  rules: [
                    { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
                    { token: 'keyword', foreground: '60a5fa' },
                    { token: 'string', foreground: '2dd4bf' },
                    { token: 'number', foreground: 'fbbf24' },
                    { token: 'regexp', foreground: 'f87171' },
                    { token: 'type', foreground: 'f472b6' },
                    { token: 'delimiter', foreground: '94a3b8' },
                  ],
                  colors: {
                    'editor.background': '#0f172a',
                    'editor.foreground': '#f1f5f9',
                    'editorLineNumber.foreground': '#64748b',
                    'editorCursor.foreground': '#2dd4bf',
                    'editor.selectionBackground': '#33415588',
                    'editor.lineHighlightBackground': '#1e293b66',
                  },
                });
              }}
              onMount={(_editor, monaco) => {
                monaco.editor.setTheme('ob-code-dark');
              }}
              options={{
                minimap: { enabled: false },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                fontSize: 14,
                lineHeight: 22,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontLigatures: true,
                wordWrap: 'on',
                tabSize: 2,
                automaticLayout: true,
                padding: { top: 8, bottom: 8 },
                renderLineHighlight: 'line',
              }}
            />
            <div className="bg-surface-secondary/40 text-text-tertiary text-2xs px-3 py-1">
              {localize('com_ui_note_edit_hint')}
            </div>
          </div>
        ) : (
          <pre className="r-cell-code code-theme-dark border-border-xheavy/60 overflow-x-auto rounded-lg border p-3 font-mono text-sm leading-6 whitespace-pre-wrap">
            <code className="hljs language-r !bg-transparent !p-0 !text-sm !leading-6 !whitespace-pre-wrap">
              {highlighted ?? (code || '# (Preparing R cell...)')}
            </code>
          </pre>
        )}
      </div>

      {showHistory && history.length > 0 && (
        <div className="border-border-light bg-surface-secondary/20 dark:border-border-heavy border-t px-3 py-2">
          <div className="text-text-secondary text-2xs mb-1 font-semibold">
            {localize('com_ui_note_history')}
          </div>
          <ul className="text-2xs max-h-32 space-y-1 overflow-y-auto">
            {history.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  className="hover:bg-surface-hover flex w-full items-center justify-between rounded px-1.5 py-1 text-left"
                  onClick={() => handleSelectHistory(h.id)}
                >
                  <span className={cn('inline-flex items-center gap-1.5', statusTone(h.status))}>
                    {statusIcon(h.status)}#{h.attempt} {statusLabel(localize, h.status)}
                  </span>
                  <span className="text-text-tertiary font-mono">
                    {h.finishedAt || h.startedAt || h.createdAt
                      ? new Date(h.finishedAt || h.startedAt || h.createdAt || '').toLocaleString()
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Output
        execution={execution}
        stdout={stdout}
        executionError={
          // A stop, a cancel or an interruption is reported once, by the status line.
          execStatus === 'timed_out' ||
          execStatus === 'cancelled' ||
          execution?.phase === 'interrupted'
            ? null
            : executionError
        }
        authPlotUrls={authPlotUrls}
        tables={tables}
        endingNotice={endingNotice(execution, localize)}
      />
    </div>
  );
}
