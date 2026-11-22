import { logger } from '@librechat/data-schemas';
import { errorMessage } from './errors';
import type { NoteEngineResult, NoteEngineStatus, Phase } from './contracts';
import type { NoteDependencies } from './serviceTypes';
import type { createEventStore } from './events';

export const POLL_INTERVAL_MS = 1500;
/** The engine's own limits for starting R (with restore) and for queueing, plus a margin. */
const START_LIMIT_SECONDS = 300;
const QUEUE_LIMIT_SECONDS = 240;
const SAFETY_MARGIN_SECONDS = 60;
/** Console text kept on the record while the cell runs (the newest part). */
const STDOUT_CAP = 1_000_000;
/** Status requests that may fail in a row (about a minute, e.g. an engine rollout). */
const MAX_POLL_FAILURES = 40;

const R_RESTARTED =
  'R was restarted, so objects made since the session was last saved are gone. Run the earlier cells again to recreate them.';
export const CANCELLED_MESSAGE: string = `Cancelled. ${R_RESTARTED}`;
export const INTERRUPTED_MESSAGE = 'Interrupted by a server restart. Run the cell again.';

export function timedOutMessage(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `Stopped after ${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}. ${R_RESTARTED}`;
}

/** Seconds after which LibreChat stops waiting for the engine and cancels the run. */
export function safetyStopSeconds(timeoutSeconds: number): number {
  return timeoutSeconds + START_LIMIT_SECONDS + QUEUE_LIMIT_SECONDS + SAFETY_MARGIN_SECONDS;
}

/** Engine times are ISO strings or seconds since the epoch. */
function toDate(value?: string | number | null): Date | null {
  if (value == null) {
    return null;
  }
  return new Date(typeof value === 'number' ? value * 1000 : value);
}

interface RunInput {
  executionId: string;
  conversationId: string;
  timeoutSeconds: number;
}

export interface EngineRunner {
  /** Saves the phase on the record and appends its event; the one place phases are written. */
  setPhase(
    executionId: string,
    conversationId: string,
    phase: Phase,
    phaseStartedAt?: Date,
  ): Promise<void>;
  /** Starts the cell on the engine and follows it to its result. */
  run(input: RunInput & { code: string }): Promise<NoteEngineResult>;
  /** Follows a run the engine was already given (after a restart of this server). */
  resume(input: RunInput): Promise<NoteEngineResult>;
}

/**
 * Follows a cell on the engine: asks its status every 1.5 s, copies phase and console
 * text into the record and returns the result. Used for cells the user runs and for
 * cells the agent runs.
 */
export function createEngineRunner(
  deps: Pick<
    NoteDependencies,
    'models' | 'startExecution' | 'getExecutionStatus' | 'signalCancel' | 'pollSleep'
  >,
  appendEvent: ReturnType<typeof createEventStore>['appendEvent'],
): EngineRunner {
  const { NoteCellExecution } = deps.models;
  const sleep =
    deps.pollSleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function setPhase(
    executionId: string,
    conversationId: string,
    phase: Phase,
    phaseStartedAt: Date = new Date(),
  ) {
    await NoteCellExecution.updateOne({ _id: executionId }, { $set: { phase, phaseStartedAt } });
    await appendEvent(executionId, conversationId, 'phase', 'running', { phase, phaseStartedAt });
  }

  async function cancelRequested(executionId: string) {
    const record = await NoteCellExecution.findById(executionId).select('cancelRequested').lean();
    return !!record?.cancelRequested;
  }

  async function cancelOnEngine(conversationId: string, executionId: string) {
    try {
      await deps.signalCancel(conversationId, executionId);
    } catch (err) {
      logger.warn(`[NoteCells] engine cancel signal failed: ${errorMessage(err)}`);
    }
  }

  function interruptedResult(): NoteEngineResult {
    return {
      success: false,
      interrupted: true,
      error: INTERRUPTED_MESSAGE,
      markdown: INTERRUPTED_MESSAGE,
    };
  }

  async function poll(
    { executionId, conversationId, timeoutSeconds }: RunInput,
    startPhase: Phase | null,
  ): Promise<NoteEngineResult> {
    const began = Date.now();
    const deadline = began + safetyStopSeconds(timeoutSeconds) * 1000;
    let phase = startPhase;
    let offset = 0;
    let stdout = '';
    let rStartedAt: Date | null = null;
    let failures = 0;

    while (true) {
      let status: NoteEngineStatus | null | undefined;
      try {
        status = await deps.getExecutionStatus({ threadId: conversationId, executionId, offset });
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw err;
        }
      }

      if (status === null) {
        await setPhase(executionId, conversationId, 'interrupted');
        return interruptedResult();
      }
      if (status) {
        if (status.phase && status.phase !== phase) {
          phase = status.phase;
          await setPhase(
            executionId,
            conversationId,
            phase,
            toDate(status.phase_started_at) ?? undefined,
          );
        }
        const patch: { rStartedAt?: Date; stdout?: string } = {};
        if (!rStartedAt && status.started_at != null) {
          rStartedAt = toDate(status.started_at);
          patch.rStartedAt = rStartedAt!;
        }
        if (status.output) {
          stdout = (stdout + status.output).slice(-STDOUT_CAP);
          patch.stdout = stdout;
        }
        offset = status.next_offset ?? offset;
        if (patch.rStartedAt || patch.stdout != null) {
          await NoteCellExecution.updateOne({ _id: executionId }, { $set: patch });
        }
        if (status.phase === 'interrupted') {
          return interruptedResult();
        }
        if (status.done) {
          return status.result ?? { success: false, error: 'The engine returned no result' };
        }
        // The cancel route signals the engine once, best-effort; repeat it until the engine has it.
        if (!status.cancel_requested && (await cancelRequested(executionId))) {
          await cancelOnEngine(conversationId, executionId);
        }
      }

      if (Date.now() >= deadline) {
        await cancelOnEngine(conversationId, executionId);
        const seconds = (Date.now() - began) / 1000;
        const message = timedOutMessage(seconds);
        return {
          success: false,
          timed_out: true,
          stopped_after_seconds: seconds,
          error: message,
          markdown: message,
        };
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  async function run(input: RunInput & { code: string }): Promise<NoteEngineResult> {
    // Cancelled while its files were being copied: the engine has not seen the run yet.
    if (await cancelRequested(input.executionId)) {
      return { success: false, cancelled: true, markdown: 'Cancelled before R ran.' };
    }
    const started = await deps.startExecution({
      code: input.code,
      threadId: input.conversationId,
      executionId: input.executionId,
      timeoutSeconds: input.timeoutSeconds,
    });
    if (started?.phase) {
      await setPhase(input.executionId, input.conversationId, started.phase);
    }
    return poll(input, started?.phase ?? null);
  }

  async function resume(input: RunInput): Promise<NoteEngineResult> {
    const record = await NoteCellExecution.findById(input.executionId).select('phase').lean();
    return poll(input, record?.phase ?? null);
  }

  return { setPhase, run, resume };
}
