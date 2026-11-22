import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { TERMINAL_STATUSES, type NoteCellExecution } from '~/data-provider/Notes/notesCellsApi';
import { statusIcon, statusLabel, statusTone } from './status';

type Localize = ReturnType<typeof useLocalize>;

/** 42 -> "0:42", 600 -> "10:00" */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Whole seconds since `startedAt`, ticking every second while `active`.
 * `serverNow` (the server's clock when it answered) removes the difference
 * between the browser's clock and the server's.
 */
export function useElapsedSeconds(
  startedAt?: string | null,
  serverNow?: string | null,
  active = true,
): number | null {
  const skewRef = useRef<number | null>(null);
  if (skewRef.current == null && serverNow) {
    skewRef.current = Date.now() - Date.parse(serverNow);
  }
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !startedAt) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);

  if (!startedAt) {
    return null;
  }
  return Math.max(0, Math.floor((now - (skewRef.current ?? 0) - Date.parse(startedAt)) / 1000));
}

export type StatusLineKind = 'cancelling' | 'interrupted' | 'waiting' | 'working' | 'ended';

function isActive(execution: NoteCellExecution): boolean {
  return !TERMINAL_STATUSES.has(execution.status) && execution.phase !== 'interrupted';
}

/** The instant the timer of the current phase counts from, if that phase shows one. */
export function timerStart(execution: NoteCellExecution): string | null {
  if (!isActive(execution) || execution.cancelRequested) {
    return null;
  }
  switch (execution.phase) {
    case 'waiting_for_slot':
    case 'starting_pod':
      return execution.phaseStartedAt ?? null;
    case 'running':
      return execution.rStartedAt ?? execution.phaseStartedAt ?? null;
    default:
      return null;
  }
}

/** What the cell header says about a run. `elapsed` is seconds since `timerStart`. */
export function statusLine(
  execution: NoteCellExecution,
  elapsed: number | null,
  localize: Localize,
): { kind: StatusLineKind; text: string } {
  // Endings stay short here; their full sentence opens the output panel (endingNotice).
  if (execution.phase === 'interrupted') {
    return { kind: 'interrupted', text: localize('com_ui_note_status_interrupted') };
  }
  if (!isActive(execution)) {
    return { kind: 'ended', text: statusLabel(localize, execution.status) };
  }
  if (execution.cancelRequested) {
    return { kind: 'cancelling', text: localize('com_ui_note_phase_cancelling') };
  }
  const clock = elapsed == null ? '' : formatClock(elapsed);
  // A run just created has no phase yet; copying the note's files comes first.
  switch (execution.phase ?? (execution.status === 'queued' ? 'preparing_files' : null)) {
    case 'preparing_files':
      return { kind: 'working', text: localize('com_ui_note_phase_preparing_files') };
    case 'engine_not_answering':
      return { kind: 'waiting', text: localize('com_ui_note_phase_engine_not_answering') };
    case 'waiting_for_slot':
      return {
        kind: 'waiting',
        text: localize('com_ui_note_phase_waiting_for_slot', { 0: clock }).trim(),
      };
    case 'starting_pod':
      return {
        kind: 'working',
        text: localize('com_ui_note_phase_starting_pod', { 0: clock }).trim(),
      };
    case 'waiting_for_cell':
      return { kind: 'waiting', text: localize('com_ui_note_phase_waiting_for_cell') };
    case 'starting_r':
      return { kind: 'working', text: localize('com_ui_note_phase_starting_r') };
    case 'restoring_session':
      return { kind: 'working', text: localize('com_ui_note_phase_restoring_session') };
    case 'running':
      return {
        kind: 'working',
        text:
          elapsed == null
            ? statusLabel(localize, 'running')
            : localize('com_ui_note_phase_running', {
                0: clock,
                1: formatClock(execution.timeoutSeconds),
              }),
      };
    default:
      return {
        kind: execution.status === 'queued' ? 'waiting' : 'working',
        text: statusLabel(localize, execution.status),
      };
  }
}

/** The full sentence of a run that was stopped, cancelled or interrupted, or null. */
export function endingNotice(
  execution: NoteCellExecution | null,
  localize: Localize,
): string | null {
  if (!execution) {
    return null;
  }
  if (execution.phase === 'interrupted') {
    return execution.error || localize('com_ui_note_phase_interrupted');
  }
  if (execution.status === 'timed_out' || execution.status === 'cancelled') {
    return execution.error || null;
  }
  return null;
}

/** The one status line of a cell: icon, phase text, timer. */
export function StatusLine({
  execution,
  isLoading,
}: {
  execution: NoteCellExecution | null;
  isLoading?: boolean;
}) {
  const localize = useLocalize();
  const start = execution ? timerStart(execution) : null;
  const elapsed = useElapsedSeconds(start, execution?.serverNow, start != null);

  if (!execution) {
    return isLoading ? (
      <span className="text-text-tertiary inline-flex items-center">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        <span className="sr-only">{localize('com_ui_note_cell_loading')}</span>
      </span>
    ) : null;
  }

  const { kind, text } = statusLine(execution, elapsed, localize);
  let icon = statusIcon(execution.status);
  let tone = statusTone(execution.status);
  if (kind === 'cancelling') {
    icon = <Loader2 className="text-status-neutral size-3 animate-spin" />;
    tone = statusTone('cancelled');
  } else if (kind === 'interrupted') {
    icon = <AlertTriangle className="text-status-warning size-3" />;
    tone = statusTone('timed_out');
  } else if (kind === 'waiting') {
    icon = statusIcon('queued');
    tone = statusTone('queued');
  } else if (kind === 'working') {
    icon = statusIcon('running');
    tone = statusTone('running');
  }

  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1 font-medium tabular-nums', tone)}
      data-testid="note-cell-status"
    >
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span>{text}</span>
    </span>
  );
}
