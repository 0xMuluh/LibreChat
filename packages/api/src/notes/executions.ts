import { logger } from '@librechat/data-schemas';
import type { Readable } from 'stream';
import type { SerializedExecution, SerializedArtifact } from './serialization';
import type { NoteDependencies, ExecutionInput } from './serviceTypes';
import type { createExecutionWorker } from './worker';
import type { createEventStore } from './events';
import { toId, serializeExecution, serializeArtifact } from './serialization';
import { errorMessage, NoteError } from './errors';
import { TERMINAL } from './constants';

/** An artifact's bytes: held in memory, or streamed for a file the run wrote. */
export type ArtifactContent = { contentType: string; artifact: SerializedArtifact } & (
  | { buffer: Buffer }
  | { stream: Readable; contentLength?: string | null }
);

/** A run this young is still being handed to its job; older ones without a job were orphaned. */
const RECONCILE_GRACE_MS = 5000;
export interface ExecutionStore {
  executeCell(input: ExecutionInput): Promise<SerializedExecution>;
  getExecution(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
  ): Promise<SerializedExecution & { artifacts: SerializedArtifact[] }>;
  listExecutions(
    conversationId: string,
    userId: string,
    cellId: string,
  ): Promise<SerializedExecution[]>;
  cancelExecution(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
  ): Promise<SerializedExecution>;
  getArtifactContent(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
    artifactId: string,
  ): Promise<ArtifactContent>;
}
export function createExecutionStore(
  deps: NoteDependencies,
  appendEvent: ReturnType<typeof createEventStore>['appendEvent'],
  enqueueExecution: ReturnType<typeof createExecutionWorker>['enqueueExecution'],
  resumeExecution: ReturnType<typeof createExecutionWorker>['resumeExecution'],
): ExecutionStore {
  const { NoteCell, NoteCellRevision, NoteCellExecution, NoteExecutionArtifact } = deps.models;
  const { fetchArtifactFromEngine, streamArtifactFromEngine, signalCancel } = deps;
  async function executeCell({
    conversationId,
    userId,
    cellId,
    revisionId = null,
    timeoutSeconds = 600,
  }: ExecutionInput) {
    const cell = await NoteCell.findOne({ _id: cellId, conversationId, user: userId });
    if (!cell) {
      throw new NoteError('Cell not found', 404);
    }

    const revId = revisionId || cell.latestRevisionId;
    if (!revId) {
      throw new NoteError('No saved revision; save before run', 400);
    }

    const revision = await NoteCellRevision.findOne({ _id: revId, cellId: cell._id });
    if (!revision) {
      throw new NoteError('Revision not found', 404);
    }

    const attempt = (await NoteCellExecution.countDocuments({ cellId: cell._id })) + 1;

    const execution = await NoteCellExecution.create({
      cellId: cell._id,
      revisionId: revision._id,
      conversationId,
      user: userId,
      attempt,
      status: 'queued',
      timeoutSeconds,
    });

    cell.latestExecutionId = execution._id;
    await cell.save();
    await appendEvent(execution._id, conversationId, 'queued', 'queued');
    enqueueExecution(execution._id);

    return serializeExecution(execution);
  }

  async function getExecution(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
  ) {
    const execution = await NoteCellExecution.findOne({
      _id: executionId,
      cellId,
      conversationId,
      user: userId,
    });
    if (!execution) {
      throw new NoteError('Execution not found', 404);
    }
    // After a server restart nothing follows the run: pick it up again (no-op while a job
    // follows it). The page keeps asking, so it sees the outcome on a later request.
    if (
      !TERMINAL.has(execution.status) &&
      execution.createdAt &&
      Date.now() - execution.createdAt.getTime() > RECONCILE_GRACE_MS
    ) {
      resumeExecution(execution._id);
    }
    const artifacts = await NoteExecutionArtifact.find({ executionId: execution._id });
    return {
      ...serializeExecution(execution),
      artifacts: artifacts.map(serializeArtifact),
    };
  }

  async function listExecutions(conversationId: string, userId: string, cellId: string) {
    const executions = await NoteCellExecution.find({
      cellId,
      conversationId,
      user: userId,
    })
      .sort({ createdAt: -1 })
      .limit(50);
    return executions.map((e) => serializeExecution(e));
  }

  async function cancelExecution(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
  ) {
    const execution = await NoteCellExecution.findOne({
      _id: executionId,
      cellId,
      conversationId,
      user: userId,
    });
    if (!execution) {
      throw new NoteError('Execution not found', 404);
    }
    if (TERMINAL.has(execution.status)) {
      return serializeExecution(execution);
    }
    execution.cancelRequested = true;
    await execution.save();
    await appendEvent(execution._id, conversationId, 'cancel_requested', execution.status);

    // Signal NoteKernel cancel flag (best-effort)
    try {
      await signalCancel(conversationId, toId(execution._id));
    } catch (err) {
      logger.warn(`[NoteCells] engine cancel signal failed: ${errorMessage(err)}`);
    }

    return serializeExecution(execution);
  }

  async function getArtifactContent(
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
    artifactId: string,
  ): Promise<ArtifactContent> {
    const execution = await NoteCellExecution.findOne({
      _id: executionId,
      cellId,
      conversationId,
      user: userId,
    });
    if (!execution) {
      throw new NoteError('Execution not found', 404);
    }
    const artifact = await NoteExecutionArtifact.findOne({
      _id: artifactId,
      executionId: execution._id,
    });
    if (!artifact) {
      throw new NoteError('Artifact not found', 404);
    }

    if (artifact.artifactType === 'console' && execution.stdout != null) {
      return {
        buffer: Buffer.from(execution.stdout, 'utf8'),
        contentType: 'text/plain; charset=utf-8',
        artifact: serializeArtifact(artifact),
      };
    }

    if (artifact.artifactType === 'file' && streamArtifactFromEngine) {
      const { stream, contentType, contentLength } = await streamArtifactFromEngine(
        conversationId,
        artifact.relativePath,
      );
      return {
        stream,
        contentLength,
        contentType: artifact.mimeType || contentType,
        artifact: serializeArtifact(artifact),
      };
    }

    const { buffer, contentType } = await fetchArtifactFromEngine(
      conversationId,
      artifact.relativePath,
    );
    return {
      buffer,
      contentType: artifact.mimeType || contentType,
      artifact: serializeArtifact(artifact),
    };
  }

  return { executeCell, getExecution, listExecutions, cancelExecution, getArtifactContent };
}
