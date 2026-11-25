import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import { inferMimeType } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  Cell,
  Revision,
  Execution,
  Event,
  Artifact,
  Status,
  NoteEngineResult,
} from './contracts';
import type { EngineRunner } from './runner';
import { CANCELLED_MESSAGE, timedOutMessage } from './runner';
import { createEventStore } from './events';
export type { NoteEngineResult } from './contracts';

function decodePath(path: string | null): string | null {
  try {
    return path == null ? null : decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** One line for the agent naming the files the run wrote, which the page offers for download. */
function savedFilesLine(result: NoteEngineResult): string {
  const names = (result.files || []).map((file) => file.path).filter(Boolean);
  if (names.length === 0) {
    return '';
  }
  const more = result.files_truncated ? ', and more' : '';
  return `\n\nFiles written (offered for download under the cell): ${names.join(', ')}${more}`;
}

export function buildNoteArtifacts(
  execution: Pick<Execution, 'conversationId' | 'user'> & { _id: Types.ObjectId },
  result: NoteEngineResult,
): Artifact[] {
  const base = {
    executionId: execution._id,
    conversationId: execution.conversationId,
    user: execution.user,
  };
  const runDir = result.engine_run_dir || result.run_dir;
  const marker = `/projects/${execution.conversationId}/`;
  const relative = (url?: string) => {
    const index = url?.indexOf(marker) ?? -1;
    return index < 0 ? null : url!.slice(index + marker.length);
  };
  const artifacts: Artifact[] = [];
  if (result.stdout != null) {
    artifacts.push({
      ...base,
      artifactType: 'console',
      relativePath: runDir ? `${runDir}/console.txt` : 'console',
      mimeType: 'text/plain',
      byteSize: Buffer.byteLength(result.stdout, 'utf8'),
    });
  }
  for (const url of result.plots || []) {
    const path = relative(url);
    if (path) {
      artifacts.push({
        ...base,
        artifactType: 'plot',
        relativePath: path,
        mimeType: 'image/png',
        byteSize: 0,
      });
    }
  }
  for (const table of result.tables || []) {
    const path =
      relative(table.url) || (runDir && table.file ? `${runDir}/tables/${table.file}` : null);
    if (path) {
      artifacts.push({
        ...base,
        artifactType: 'table',
        relativePath: path,
        mimeType: 'text/csv',
        byteSize: 0,
        previewMarkdown: table.markdown || null,
        rows: table.rows ?? null,
        cols: table.cols ?? null,
      });
    }
  }
  const registered = new Set(artifacts.map((artifact) => artifact.relativePath));
  for (const file of result.files || []) {
    // `path` is the raw name; `url` is percent-encoded, and the content route encodes once.
    const path = file.path || decodePath(relative(file.url));
    // Paths stay inside the note folder: the content route joins them to its URL.
    if (!path || path.startsWith('/') || path.split('/').includes('..') || registered.has(path)) {
      continue;
    }
    registered.add(path);
    artifacts.push({
      ...base,
      artifactType: 'file',
      relativePath: path,
      mimeType: inferMimeType(path, '') || 'application/octet-stream',
      byteSize: Number.isFinite(file.bytes) ? Number(file.bytes) : 0,
    });
  }
  return artifacts;
}

interface AgentCellIds {
  cellId: string;
  revisionId: string;
  executionId: string;
}
interface AgentLifecycle {
  start(
    conversationId: string,
    user: string,
    content: string,
    timeoutSeconds?: number,
    targetCellId?: string,
    /** Key the page already computes for the cell's card, so the card finds the run. */
    blockKey?: string,
  ): Promise<AgentCellIds>;
  finish(
    conversationId: string,
    executionId: string,
    result: NoteEngineResult,
  ): Promise<{ status: Status }>;
}

export function createNoteAgentLifecycle(models: {
  NoteCell: Model<Cell>;
  NoteCellRevision: Model<Revision>;
  NoteCellExecution: Model<Execution>;
  NoteExecutionArtifact: Model<Artifact>;
  NoteExecutionEvent: Model<Event>;
}): AgentLifecycle {
  const { appendEvent } = createEventStore(models);
  return {
    async start(
      conversationId: string,
      user: string,
      content: string,
      timeoutSeconds = 600,
      targetCellId?: string,
      blockKey?: string,
    ): Promise<AgentCellIds> {
      let cellId: Types.ObjectId;
      let revisionNumber = 1;
      let attemptNumber = 1;

      if (targetCellId && Types.ObjectId.isValid(targetCellId)) {
        const existingCell = await models.NoteCell.findOne({
          _id: new Types.ObjectId(targetCellId),
          conversationId,
        });
        if (existingCell) {
          cellId = existingCell._id as Types.ObjectId;
          const lastRevision = await models.NoteCellRevision.findOne({ cellId }).sort({
            revision: -1,
          });
          if (lastRevision && typeof lastRevision.revision === 'number') {
            revisionNumber = lastRevision.revision + 1;
          }
          const lastExecution = await models.NoteCellExecution.findOne({ cellId }).sort({
            attempt: -1,
          });
          if (lastExecution && typeof lastExecution.attempt === 'number') {
            attemptNumber = lastExecution.attempt + 1;
          }
        } else {
          cellId = new Types.ObjectId();
        }
      } else {
        cellId = new Types.ObjectId();
      }

      const revisionId = new Types.ObjectId();
      const executionId = new Types.ObjectId();
      await models.NoteCellRevision.create({
        _id: revisionId,
        cellId,
        conversationId,
        user,
        revision: revisionNumber,
        content,
      });
      await models.NoteCellExecution.create({
        _id: executionId,
        cellId,
        revisionId,
        conversationId,
        user,
        status: 'running',
        attempt: attemptNumber,
        timeoutSeconds,
        startedAt: new Date(),
      });
      await models.NoteCell.updateOne(
        { _id: cellId },
        {
          $set: {
            conversationId,
            user,
            latestRevisionId: revisionId,
            latestExecutionId: executionId,
            ...(blockKey ? { blockKey } : {}),
          },
        },
        { upsert: true },
      );
      await appendEvent(executionId, conversationId, 'running', 'running');
      return {
        cellId: String(cellId),
        revisionId: String(revisionId),
        executionId: String(executionId),
      };
    },
    async finish(
      conversationId: string,
      executionId: string,
      result: NoteEngineResult,
    ): Promise<{ status: Status }> {
      const execution = await models.NoteCellExecution.findOne({
        _id: executionId,
        conversationId,
      });
      if (!execution) {
        throw Object.assign(new Error('Execution not found'), { status: 404 });
      }
      if (execution.status !== 'running' && execution.status !== 'queued') {
        return { status: execution.status };
      }
      // A cancel the user asked for stands even when the engine's result arrives after it.
      let status: Status = 'completed';
      let error = result.error || null;
      if (result.cancelled || execution.cancelRequested) {
        status = 'cancelled';
        // R is only restarted when it was running this cell.
        error = execution.rStartedAt ? CANCELLED_MESSAGE : 'Cancelled.';
      } else if (result.timed_out) {
        status = 'timed_out';
        error = timedOutMessage(result.stopped_after_seconds ?? execution.timeoutSeconds);
      } else if (result.success === false) {
        status = 'failed';
        error = result.error || 'Execution failed';
      }
      // Keep the execution non-terminal until its artifact rows exist. The page stops
      // polling as soon as it sees a terminal status, so saving that status first would
      // show a finished cell without its plots.
      const artifacts = buildNoteArtifacts(execution, result);
      if (artifacts.length) {
        await models.NoteExecutionArtifact.insertMany(artifacts);
      }
      await models.NoteCellExecution.updateOne(
        { _id: execution._id },
        {
          $set: {
            status,
            finishedAt: new Date(),
            // A stopped run keeps the console text the user watched; the engine's own answer
            // then holds only its notice. Without a result (interrupted, safety stop) it stays too.
            stdout:
              (status === 'cancelled' || status === 'timed_out') && execution.stdout
                ? execution.stdout
                : (result.stdout ?? execution.stdout ?? ''),
            markdown: result.markdown || '',
            error,
            engineCellId: result.cell_id || null,
            engineRunDir: result.engine_run_dir || result.run_dir || null,
            bookRefs: result.book_refs ?? null,
            filesTruncated: result.files_truncated === true,
          },
        },
      );
      await appendEvent(execution._id, conversationId, status, status, { error });
      return { status };
    },
  };
}

/** Runs one cell the agent wrote and returns what the agent reads. */
export type AgentCellRunner = (input: {
  conversationId: string;
  code: string;
  cellId?: string;
  /** Id of the agent's tool call; the page keys the cell's card on it. */
  toolCallId?: string;
  /** The reply's abort signal: Stop cancels the cell on the engine. */
  signal?: AbortSignal;
}) => Promise<string>;

/** As long as the engine lets a cell run. */
const AGENT_CELL_TIMEOUT_SECONDS = 600;

/**
 * Runs a cell the agent wrote: saves it, runs it on the engine and saves the result. The
 * engine never calls back, so it can run on another machine. Returns what the agent reads.
 */
export function createAgentCellRunner(deps: {
  lifecycle: AgentLifecycle;
  resolveUser: (conversationId: string) => Promise<string | null>;
  bridgeConversationFiles: (conversationId: string, userId: string) => Promise<void>;
  engine: EngineRunner;
  cancelExecution: (
    conversationId: string,
    userId: string,
    cellId: string,
    executionId: string,
  ) => Promise<unknown>;
  /** Registers the run as followed by this server, so the restart check leaves it alone. */
  track?: (executionId: string, job: Promise<unknown>) => void;
}): AgentCellRunner {
  async function runSavedCell(
    ids: AgentCellIds,
    user: string,
    conversationId: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Stop takes the same path as the cell's Cancel button; the engine then answers "cancelled".
    const cancel = () => {
      deps
        .cancelExecution(conversationId, user, ids.cellId, ids.executionId)
        .catch((error) =>
          logger.warn(`[NoteCells] agent cell cancel failed: ${(error as Error).message}`),
        );
    };
    if (signal?.aborted) {
      cancel();
    } else {
      signal?.addEventListener('abort', cancel, { once: true });
    }

    let result: NoteEngineResult;
    try {
      await deps.engine.setPhase(ids.executionId, conversationId, 'preparing_files');
      await deps.bridgeConversationFiles(conversationId, user).catch((error) => {
        throw new Error(
          `the note's files could not be copied, so R was not executed: ${(error as Error).message}`,
        );
      });
      result = await deps.engine.run({
        executionId: ids.executionId,
        conversationId,
        code,
        timeoutSeconds: AGENT_CELL_TIMEOUT_SECONDS,
      });
    } catch (error) {
      const message = (error as Error).message;
      result = { success: false, error: message, markdown: `Execution failed: ${message}` };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }

    let status: Status;
    let warning = '';
    try {
      ({ status } = await deps.lifecycle.finish(conversationId, ids.executionId, result));
    } catch (error) {
      const message = (error as Error).message;
      warning = `\n\nResult could not be saved: ${message}. R has already run; do not rerun automatically.`;
      // Close the cell with a small result so it is never left running.
      ({ status } = await deps.lifecycle
        .finish(conversationId, ids.executionId, {
          success: false,
          error: `The result could not be saved: ${message}`,
          markdown: `R ran, but its result could not be saved: ${message}`,
          cell_id: result.cell_id,
          engine_run_dir: result.engine_run_dir,
        })
        .catch(() => ({ status: 'failed' as Status })));
    }
    return (
      `<!-- noteCell cellId=${ids.cellId} executionId=${ids.executionId} status=${status} -->\n` +
      `[cell_id: "${ids.cellId}"]\n${result.markdown ?? ''}${savedFilesLine(result)}${warning}`
    );
  }

  return async function runAgentCell({ conversationId, code, cellId, toolCallId, signal }) {
    let ids: AgentCellIds;
    let user: string;
    try {
      const found = conversationId ? await deps.resolveUser(conversationId) : null;
      if (!found) {
        throw new Error('the note was not found');
      }
      user = found;
      ids = await deps.lifecycle.start(
        conversationId,
        user,
        code,
        AGENT_CELL_TIMEOUT_SECONDS,
        cellId?.trim() || undefined,
        toolCallId ? `tool-${toolCallId}` : undefined,
      );
    } catch (error) {
      return `Could not save the code cell; R was not executed: ${(error as Error).message}`;
    }
    const job = runSavedCell(ids, user, conversationId, code, signal);
    deps.track?.(ids.executionId, job);
    return job;
  };
}
