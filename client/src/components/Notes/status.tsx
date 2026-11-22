import { Clock, Loader2, CheckCircle2, XCircle, AlertTriangle, Square } from 'lucide-react';
import type { useLocalize } from '~/hooks';
import type { NoteCellExecutionStatus } from '~/data-provider/Notes/notesCellsApi';

type Localize = ReturnType<typeof useLocalize>;

export function statusLabel(localize: Localize, status?: NoteCellExecutionStatus | null): string {
  switch (status) {
    case 'queued':
      return localize('com_ui_note_status_queued');
    case 'running':
      return localize('com_ui_note_status_running');
    case 'completed':
      return localize('com_ui_note_status_completed');
    case 'failed':
      return localize('com_ui_note_status_failed');
    case 'timed_out':
      return localize('com_ui_note_status_timed_out');
    case 'cancelled':
      return localize('com_ui_note_status_cancelled');
    default:
      return '';
  }
}

export function statusTone(status?: NoteCellExecutionStatus | null): string {
  switch (status) {
    case 'queued':
      return 'text-status-warning';
    case 'running':
      return 'text-status-info';
    case 'completed':
      return 'text-status-success';
    case 'failed':
      return 'text-status-error';
    case 'timed_out':
      return 'text-status-warning';
    case 'cancelled':
      return 'text-status-neutral';
    default:
      return 'text-text-tertiary';
  }
}

export function statusIcon(status?: NoteCellExecutionStatus | null) {
  switch (status) {
    case 'queued':
      return <Clock className="text-status-warning size-3" />;
    case 'running':
      return <Loader2 className="text-status-info size-3 animate-spin" />;
    case 'completed':
      return <CheckCircle2 className="text-status-success size-3" />;
    case 'failed':
      return <XCircle className="text-status-error size-3" />;
    case 'timed_out':
      return <AlertTriangle className="text-status-warning size-3" />;
    case 'cancelled':
      return <Square className="text-status-neutral size-3" />;
    default:
      return null;
  }
}
