import type { Model, Types } from 'mongoose';
import type {
  Cell,
  Revision,
  Execution,
  Event,
  Artifact,
  Phase,
  NoteEngineStatus,
  NoteEngineStartInput,
} from './contracts';
export type Identifier = string | Types.ObjectId;
export interface NoteModels {
  NoteCell: Model<Cell>;
  NoteCellRevision: Model<Revision>;
  NoteCellExecution: Model<Execution>;
  NoteExecutionEvent: Model<Event>;
  NoteExecutionArtifact: Model<Artifact>;
}
export interface NoteDependencies {
  models: NoteModels;
  getConversationModel: () => Model<{ conversationId: string; user: string }> | undefined;
  getSharedLinkModel?: () =>
    | Model<{ conversationId: string; user: string; shareId: string; expiredAt?: Date }>
    | undefined;
  bridgeConversationFiles: (conversationId: string, userId: string) => Promise<void>;
  /** Starts the cell on the engine and returns at once. */
  startExecution: (input: NoteEngineStartInput) => Promise<{ phase?: Phase }>;
  /** The run's status on the engine; null when the engine does not know it. */
  getExecutionStatus: (input: {
    threadId: string;
    executionId: string;
    offset: number;
  }) => Promise<NoteEngineStatus | null>;
  /** The error a cell ends with when status requests kept failing; names the engine's host. */
  engineUnreachableError?: (cause: unknown) => Error;
  /** Pause between two status requests; replaced in specs. */
  pollSleep?: (ms: number) => Promise<void>;
  fetchArtifactFromEngine: (
    conversationId: string,
    relativePath: string,
  ) => Promise<{ buffer: Buffer; contentType: string }>;
  signalCancel: (conversationId: string, executionId: string) => Promise<void>;
}
export interface CellInput {
  conversationId: string;
  userId: string;
  content?: string;
  cellId?: string | null;
  messageId?: string | null;
  blockKey?: string | null;
  position?: number;
}
export interface RevisionInput {
  conversationId: string;
  userId: string;
  cellId: string;
  content: string;
  language?: string;
}
export interface ExecutionInput {
  conversationId: string;
  userId: string;
  cellId: string;
  revisionId?: string | null;
  timeoutSeconds?: number;
}
