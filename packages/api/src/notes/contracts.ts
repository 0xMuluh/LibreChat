import type { Types } from 'mongoose';

export type Status = 'queued' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
/**
 * Where a run is. `preparing_files` and `engine_not_answering` are set by LibreChat, the
 * rest by the engine.
 */
export type Phase =
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
export interface Cell {
  messageId: string | null;
  blockKey: string | null;
  position: number;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
  conversationId: string;
  user: string;
  latestRevisionId: Types.ObjectId | null;
  latestExecutionId: Types.ObjectId | null;
}
export interface Revision {
  language: string;
  createdAt?: Date;
  cellId: Types.ObjectId;
  conversationId: string;
  user: string;
  revision: number;
  content: string;
}
export interface Execution {
  createdAt?: Date;
  updatedAt?: Date;
  cellId: Types.ObjectId;
  revisionId: Types.ObjectId;
  conversationId: string;
  user: string;
  status: Status;
  attempt: number;
  timeoutSeconds: number;
  startedAt: Date;
  finishedAt?: Date;
  cancelRequested?: boolean;
  stdout?: string;
  markdown?: string;
  error?: string | null;
  engineCellId?: string | null;
  engineRunDir?: string | null;
  phase?: Phase | null;
  phaseStartedAt?: Date | null;
  /** When R began running the cell; the time limit counts from here. */
  rStartedAt?: Date | null;
  /** The engine's `book_refs`, stored as received. */
  bookRefs?: Record<string, unknown> | null;
}
export interface EventPayload {
  error?: string | null;
  phase?: Phase;
  phaseStartedAt?: Date;
}
export interface Event {
  payload?: EventPayload | null;
  createdAt?: Date;
  executionId: Types.ObjectId;
  conversationId: string;
  sequence: number;
  eventType: string;
  status: Status;
}
export interface Artifact {
  createdAt?: Date;
  executionId: Types.ObjectId;
  conversationId: string;
  user: string;
  artifactType: 'console' | 'plot' | 'table';
  relativePath: string;
  mimeType: string;
  byteSize: number;
  previewMarkdown?: string | null;
  rows?: number | null;
  cols?: number | null;
}
export interface NoteEngineResult {
  success?: boolean;
  cancelled?: boolean;
  timed_out?: boolean;
  stdout?: string;
  markdown?: string;
  error?: string;
  cell_id?: string;
  engine_run_dir?: string;
  run_dir?: string;
  plots?: string[];
  tables?: { url?: string; file?: string; markdown?: string; rows?: number; cols?: number }[];
  book_refs?: Record<string, unknown> | null;
  /** Set by LibreChat: the engine no longer knows the run (server restart). */
  interrupted?: boolean;
  /** Set by LibreChat when its safety stop ended the run. */
  stopped_after_seconds?: number;
}
/** Answer of `GET /api/executions/{execution_id}` on the engine. */
export interface NoteEngineStatus {
  phase: Phase;
  phase_started_at?: string | number | null;
  started_at?: string | number | null;
  cancel_requested?: boolean;
  output?: string;
  next_offset?: number;
  done?: boolean;
  result?: NoteEngineResult | null;
}
export interface NoteEngineStartInput {
  code: string;
  threadId: string;
  executionId: string;
  timeoutSeconds: number;
}
