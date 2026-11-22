import { logger } from '@librechat/data-schemas';
import { errorMessage } from './errors';
import { toId } from './serialization';
import { TERMINAL } from './constants';
import type { NoteEngineResult } from './contracts';
import type { NoteDependencies, Identifier } from './serviceTypes';
import type { createNoteAgentLifecycle } from './agent';
import type { createEventStore } from './events';
import { INTERRUPTED_MESSAGE } from './runner';
import type { EngineRunner } from './runner';

/** Two hours: longer than the safety stop of any cell. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export interface ExecutionWorker {
  enqueueExecution(id: Identifier): Promise<void> | undefined;
  /** Follows a run this server is not following (after a restart) and saves its result. */
  resumeExecution(id: Identifier): Promise<void> | undefined;
  /** Registers a run followed elsewhere in this server (agent cells). */
  trackExecution(id: Identifier, job: Promise<unknown>): void;
  waitForExecution(id: string): Promise<void> | undefined;
  /** Resumes every run still queued or running; called once when the server starts. */
  sweepExecutions(): Promise<number>;
}
export function createExecutionWorker(
  deps: NoteDependencies,
  appendEvent: ReturnType<typeof createEventStore>['appendEvent'],
  runner: EngineRunner,
  finish: ReturnType<typeof createNoteAgentLifecycle>['finish'],
): ExecutionWorker {
  const { NoteCellExecution, NoteCellRevision } = deps.models;
  const { bridgeConversationFiles } = deps;
  /** Runs this server follows; a non-terminal run missing here was orphaned by a restart. */
  const runningJobs = new Map<string, Promise<void>>();

  async function processExecution(executionId: Identifier, resume: boolean) {
    const execution = await NoteCellExecution.findById(executionId);
    if (!execution || TERMINAL.has(execution.status)) {
      return;
    }
    const input = {
      executionId: toId(execution._id),
      conversationId: execution.conversationId,
      timeoutSeconds: execution.timeoutSeconds,
    };

    let result: NoteEngineResult;
    try {
      if (resume) {
        result = await runner.resume(input);
      } else {
        const revision = await NoteCellRevision.findById(execution.revisionId);
        if (!revision) {
          execution.status = 'failed';
          execution.error = 'Revision not found';
          execution.finishedAt = new Date();
          await execution.save();
          await appendEvent(execution._id, execution.conversationId, 'failed', 'failed', {
            error: execution.error,
          });
          return;
        }

        execution.status = 'running';
        execution.startedAt = new Date();
        await execution.save();
        await appendEvent(execution._id, execution.conversationId, 'running', 'running');

        await runner.setPhase(input.executionId, input.conversationId, 'preparing_files');
        await bridgeConversationFiles(execution.conversationId, execution.user);
        result = await runner.run({ ...input, code: revision.content });
      }
    } catch (err) {
      const message = errorMessage(err) || String(err);
      result = { success: false, error: message, markdown: `Execution failed: ${message}` };
    }
    await finish(input.conversationId, input.executionId, result);
  }

  function trackExecution(executionId: Identifier, job: Promise<unknown>) {
    const key = toId(executionId);
    const promise = job
      .then(
        () => undefined,
        (err) => {
          logger.error(`[NoteCells] execution job failed: ${errorMessage(err)}`);
        },
      )
      .finally(() => {
        runningJobs.delete(key);
      });
    runningJobs.set(key, promise);
    return promise;
  }

  function start(executionId: Identifier, resume: boolean) {
    const key = toId(executionId);
    return runningJobs.get(key) ?? trackExecution(key, processExecution(executionId, resume));
  }

  async function sweepExecutions() {
    const openFilter = { status: { $in: ['queued', 'running'] } };
    // Older than any run's safety stop: nothing can still be running it, so no engine call.
    const stale = { ...openFilter, createdAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) } };
    await NoteCellExecution.updateMany(stale, {
      $set: {
        status: 'failed',
        phase: 'interrupted',
        error: INTERRUPTED_MESSAGE,
        finishedAt: new Date(),
      },
    });
    const open = await NoteCellExecution.find(openFilter).select('_id').lean();
    for (const execution of open) {
      start(execution._id, true);
    }
    return open.length;
  }

  return {
    enqueueExecution: (id: Identifier) => start(id, false),
    resumeExecution: (id: Identifier) => start(id, true),
    trackExecution: (id: Identifier, job: Promise<unknown>) => {
      trackExecution(id, job);
    },
    waitForExecution: (id: string) => runningJobs.get(id),
    sweepExecutions,
  };
}
