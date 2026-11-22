import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { NoteEngineStatus } from './contracts';
import models from '../../../../api/server/services/NoteCells/models';
import {
  createEngineRunner,
  safetyStopSeconds,
  timedOutMessage,
  CANCELLED_MESSAGE,
  INTERRUPTED_MESSAGE,
} from './runner';
import { createEventStore } from './events';

let mongo: MongoMemoryServer;
const start = jest.fn(async () => ({ phase: 'waiting_for_slot' as const }));
const status = jest.fn<Promise<NoteEngineStatus | null>, [{ offset: number }]>();
const signalCancel = jest.fn(async () => {});
const runner = createEngineRunner(
  {
    models,
    startExecution: start,
    getExecutionStatus: status,
    signalCancel,
    pollSleep: async () => {},
  },
  createEventStore(models).appendEvent,
);

/** Answers the status requests in order; the last answer repeats. */
function engineAnswers(answers: (NoteEngineStatus | null | Error)[]) {
  const queue = [...answers];
  status.mockImplementation(async () => {
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  });
}

async function makeExecution(fields: Record<string, unknown> = {}) {
  const execution = await models.NoteCellExecution.create({
    cellId: new Types.ObjectId(),
    revisionId: new Types.ObjectId(),
    conversationId: 'note',
    user: 'alice',
    status: 'running',
    ...fields,
  });
  return { executionId: String(execution._id), conversationId: 'note', timeoutSeconds: 600 };
}

async function phaseEvents(executionId: string) {
  const events = await models.NoteExecutionEvent.find({ executionId }).sort({ sequence: 1 });
  return events.map(
    (event: { sequence: number; eventType: string; payload: { phase: string } }) => [
      event.sequence,
      event.eventType,
      event.payload.phase,
    ],
  );
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
afterEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
  jest.clearAllMocks();
});

test('starts the cell without waiting and follows it to its result', async () => {
  const input = await makeExecution();
  const result = { success: true, stdout: 'ab', book_refs: { sections: [] } };
  engineAnswers([
    { phase: 'starting_r', phase_started_at: '2026-11-22T10:00:00Z', next_offset: 0 },
    {
      phase: 'running',
      phase_started_at: '2026-11-22T10:00:05Z',
      started_at: '2026-11-22T10:00:05Z',
      output: 'a',
      next_offset: 1,
    },
    { phase: 'running', started_at: '2026-11-22T10:00:05Z', output: 'b', next_offset: 2 },
    { phase: 'done', done: true, next_offset: 2, result },
  ]);

  expect(await runner.run({ ...input, code: 'cat("ab")' })).toEqual(result);

  expect(start).toHaveBeenCalledWith({
    code: 'cat("ab")',
    threadId: 'note',
    executionId: input.executionId,
    timeoutSeconds: 600,
  });
  expect(status.mock.calls.map(([call]) => call.offset)).toEqual([0, 0, 1, 2]);
  const record = await models.NoteCellExecution.findById(input.executionId);
  expect(record.phase).toBe('done');
  expect(record.stdout).toBe('ab');
  expect(record.rStartedAt).toEqual(new Date('2026-11-22T10:00:05Z'));
  expect(await phaseEvents(input.executionId)).toEqual([
    [1, 'phase', 'waiting_for_slot'],
    [2, 'phase', 'starting_r'],
    [3, 'phase', 'running'],
    [4, 'phase', 'done'],
  ]);
});

test('the phase carries the time the engine entered it', async () => {
  const input = await makeExecution();
  engineAnswers([{ phase: 'starting_pod', phase_started_at: 1795341600 }, null]);
  await runner.run({ ...input, code: '1' });
  const events = await models.NoteExecutionEvent.find({ executionId: input.executionId }).sort({
    sequence: 1,
  });
  expect(events[1].payload).toEqual({
    phase: 'starting_pod',
    phaseStartedAt: new Date(1795341600 * 1000),
  });
});

test('a run the engine does not know is interrupted', async () => {
  const input = await makeExecution();
  engineAnswers([null]);
  expect(await runner.run({ ...input, code: '1' })).toEqual({
    success: false,
    interrupted: true,
    error: INTERRUPTED_MESSAGE,
    markdown: INTERRUPTED_MESSAGE,
  });
  expect((await models.NoteCellExecution.findById(input.executionId)).phase).toBe('interrupted');
});

test('a run the engine reports as interrupted ends with the same result', async () => {
  const input = await makeExecution();
  engineAnswers([{ phase: 'interrupted' }]);
  expect(await runner.run({ ...input, code: '1' })).toMatchObject({ interrupted: true });
  expect(await phaseEvents(input.executionId)).toEqual([
    [1, 'phase', 'waiting_for_slot'],
    [2, 'phase', 'interrupted'],
  ]);
});

test('the safety stop cancels the run on the engine and reports a timeout', async () => {
  // A limit that puts the safety stop at zero seconds, so the first check fires it.
  const input = { ...(await makeExecution()), timeoutSeconds: -safetyStopSeconds(0) };
  engineAnswers([{ phase: 'running' }]);
  const result = await runner.run({ ...input, code: 'Sys.sleep(Inf)' });
  expect(signalCancel).toHaveBeenCalledWith('note', input.executionId);
  expect(result).toMatchObject({ success: false, timed_out: true });
  expect(result.error).toBe(timedOutMessage(result.stopped_after_seconds!));
  expect(status).toHaveBeenCalledTimes(1);
});

test('the safety stop leaves room for the limit, R start, queueing and a margin', () => {
  expect(safetyStopSeconds(600)).toBe(600 + 300 + 240 + 60);
});

test('a cell cancelled before the engine got it is not started', async () => {
  const input = await makeExecution({ cancelRequested: true });
  expect(await runner.run({ ...input, code: '1' })).toMatchObject({ cancelled: true });
  expect(start).not.toHaveBeenCalled();
  expect(status).not.toHaveBeenCalled();
});

test('a cancel the engine has not seen is sent again', async () => {
  const input = await makeExecution({ cancelRequested: true });
  engineAnswers([
    { phase: 'running', cancel_requested: false },
    { phase: 'running', cancel_requested: true },
    { phase: 'done', done: true, result: { success: false, cancelled: true } },
  ]);
  expect(await runner.resume(input)).toEqual({ success: false, cancelled: true });
  expect(signalCancel).toHaveBeenCalledTimes(1);
});

test('one failed status request does not end the run', async () => {
  const input = await makeExecution();
  engineAnswers([
    new Error('Engine HTTP 502'),
    { phase: 'done', done: true, result: { success: true } },
  ]);
  expect(await runner.run({ ...input, code: '1' })).toEqual({ success: true });
});

test('an engine that keeps failing ends the run with its error', async () => {
  const input = await makeExecution();
  engineAnswers([new Error('Engine HTTP 502')]);
  await expect(runner.run({ ...input, code: '1' })).rejects.toThrow('Engine HTTP 502');
});

test('resuming reads the console from the start and repeats no phase event', async () => {
  const input = await makeExecution({ phase: 'running', stdout: 'old' });
  engineAnswers([
    { phase: 'running', output: 'old and new', next_offset: 11 },
    { phase: 'done', done: true, result: { success: true } },
  ]);
  await runner.resume(input);
  expect(start).not.toHaveBeenCalled();
  expect(status.mock.calls[0][0].offset).toBe(0);
  expect((await models.NoteCellExecution.findById(input.executionId)).stdout).toBe('old and new');
  expect(await phaseEvents(input.executionId)).toEqual([[1, 'phase', 'done']]);
});

test('wording of the endings', () => {
  const restarted =
    'R was restarted, so objects made since the session was last saved are gone. Run the earlier cells again to recreate them.';
  expect(timedOutMessage(600)).toBe(`Stopped after 10:00. ${restarted}`);
  expect(timedOutMessage(75)).toBe(`Stopped after 1:15. ${restarted}`);
  expect(CANCELLED_MESSAGE).toBe(`Cancelled. ${restarted}`);
  expect(INTERRUPTED_MESSAGE).toBe('Interrupted by a server restart. Run the cell again.');
});
