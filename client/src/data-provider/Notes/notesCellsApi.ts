import { request } from 'librechat-data-provider';

export type NoteCellExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type NoteArtifact = {
  id: string;
  executionId: string;
  artifactType: 'plot' | 'table' | 'console' | 'file';
  relativePath: string;
  mimeType: string;
  byteSize: number;
  previewMarkdown?: string | null;
  rows?: number | null;
  cols?: number | null;
  contentUrl?: string | null;
};

export type NoteCellRevision = {
  id: string;
  cellId: string;
  revision: number;
  language: string;
  content: string;
  createdAt?: string;
};

export type NoteCellPhase =
  | 'preparing_files'
  | 'engine_not_answering'
  | 'waiting_for_slot'
  | 'starting_pod'
  | 'waiting_for_cell'
  | 'starting_r'
  | 'restoring_session'
  | 'running'
  | 'done'
  | 'interrupted';

export type NoteBookRef = {
  function: string;
  package: string;
  book: string;
  book_short: string;
  book_title: string;
  chapter: string;
  heading: string;
  url: string;
  looked_up: boolean;
};

export type NoteBookRefs = {
  status: 'from_book' | 'not_in_books';
  shown: NoteBookRef | null;
  refs: NoteBookRef[];
  missing: Array<{ function: string; package: string }>;
  book_versions: Record<string, string>;
};

export type NoteCellExecution = {
  id: string;
  cellId: string;
  revisionId: string;
  attempt: number;
  status: NoteCellExecutionStatus;
  timeoutSeconds: number;
  cancelRequested?: boolean;
  error?: string | null;
  stdout?: string | null;
  markdown?: string | null;
  phase?: NoteCellPhase | null;
  phaseStartedAt?: string | null;
  rStartedAt?: string | null;
  serverNow?: string | null;
  bookRefs?: NoteBookRefs | null;
  /** The run wrote more files than are listed. */
  filesTruncated?: boolean;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  artifacts?: NoteArtifact[];
};

export type NoteCell = {
  id: string;
  /** Left out when the cell is read through a share. */
  conversationId?: string;
  messageId?: string | null;
  blockKey?: string | null;
  position?: number;
  status?: string;
  latestRevisionId?: string | null;
  latestExecutionId?: string | null;
  revision?: NoteCellRevision;
  latestExecution?: NoteCellExecution;
  createdAt?: string;
  updatedAt?: string;
};

const base = (conversationId: string) => `/api/notes/${encodeURIComponent(conversationId)}`;

export const noteCellsApi = {
  listCells: (conversationId: string) =>
    request.get(`${base(conversationId)}/cells`) as Promise<{ cells: NoteCell[] }>,

  createOrFindCell: (
    conversationId: string,
    body: {
      content?: string;
      messageId?: string | null;
      blockKey?: string | null;
      cellId?: string;
    },
  ) => request.post(`${base(conversationId)}/cells`, body) as Promise<NoteCell>,

  /** The cell an agent tool call created; 404 until the agent's run has created it. */
  findCellByBlockKey: (conversationId: string, blockKey: string) =>
    request.get(
      `${base(conversationId)}/cells?blockKey=${encodeURIComponent(blockKey)}`,
    ) as Promise<NoteCell>,

  getCell: (conversationId: string, cellId: string) =>
    request.get(`${base(conversationId)}/cells/${encodeURIComponent(cellId)}`) as Promise<NoteCell>,

  appendRevision: (conversationId: string, cellId: string, content: string) =>
    request.post(`${base(conversationId)}/cells/${encodeURIComponent(cellId)}/revisions`, {
      content,
      language: 'r',
    }) as Promise<NoteCellRevision>,

  execute: (conversationId: string, cellId: string, revisionId?: string) =>
    request.post(`${base(conversationId)}/cells/${encodeURIComponent(cellId)}/execute`, {
      revisionId,
    }) as Promise<NoteCellExecution>,

  getExecution: (conversationId: string, cellId: string, executionId: string) =>
    request.get(
      `${base(conversationId)}/cells/${encodeURIComponent(cellId)}/executions/${encodeURIComponent(executionId)}`,
    ) as Promise<NoteCellExecution>,

  listExecutions: (conversationId: string, cellId: string) =>
    request.get(
      `${base(conversationId)}/cells/${encodeURIComponent(cellId)}/executions`,
    ) as Promise<{ executions: NoteCellExecution[] }>,

  cancel: (conversationId: string, cellId: string, executionId: string) =>
    request.post(
      `${base(conversationId)}/cells/${encodeURIComponent(cellId)}/executions/${encodeURIComponent(executionId)}/cancel`,
      {},
    ) as Promise<NoteCellExecution>,

  listEvents: (conversationId: string, cellId: string, executionId: string, afterSequence = 0) =>
    request.get(
      `${base(conversationId)}/cells/${encodeURIComponent(cellId)}/executions/${encodeURIComponent(executionId)}/events?after_sequence=${afterSequence}`,
    ) as Promise<{ events: Array<{ sequence: number; eventType: string; status?: string }> }>,
};

export const TERMINAL_STATUSES = new Set<NoteCellExecutionStatus>([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);

export function artifactAuthUrl(contentUrl?: string | null): string | undefined {
  if (!contentUrl) {
    return undefined;
  }
  if (contentUrl.startsWith('http')) {
    return contentUrl;
  }
  return contentUrl;
}
