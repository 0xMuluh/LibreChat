import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAgentCellRunner, createNoteAgentLifecycle } from './agent';

import models from '../../../../api/server/services/NoteCells/models';
const lifecycle = createNoteAgentLifecycle(models);
let mongo: MongoMemoryServer;

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
});

test('saves one revision and a complete result with bulk artifacts, without polling', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'print(42)');
  const revisions = await models.NoteCellRevision.find({ cellId: saved.cellId });
  expect(revisions).toHaveLength(1);
  expect(revisions[0].content).toBe('print(42)');
  const cell = await models.NoteCell.findById(saved.cellId);
  expect(String(cell.latestExecutionId)).toBe(saved.executionId);
  const inserts = jest.spyOn(models.NoteExecutionArtifact, 'insertMany');
  const result = await lifecycle.finish('test-conversation', saved.executionId, {
    success: true,
    stdout: '42',
    markdown: '42',
    run_dir: 'runs/test',
    plots: ['http://engine/projects/test-conversation/runs/test/plots/1.png'],
    tables: [{ file: 'table.csv', markdown: '| x |', rows: 1, cols: 1 }],
  });
  expect(result.status).toBe('completed');
  expect(inserts).toHaveBeenCalledTimes(1);
  expect(
    await models.NoteExecutionArtifact.countDocuments({ executionId: saved.executionId }),
  ).toBe(3);
  expect((await models.NoteCellExecution.findById(saved.executionId)).stdout).toBe('42');
  await lifecycle.finish('test-conversation', saved.executionId, { success: true });
  expect(inserts).toHaveBeenCalledTimes(1);
});

test.each([
  [{ success: false, error: 'R failed' }, 'failed'],
  [{ success: false, timed_out: true }, 'timed_out'],
  [{ success: false, cancelled: true }, 'cancelled'],
] as const)('persists terminal outcome %s', async (result, status) => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'code');
  expect(await lifecycle.finish('test-conversation', saved.executionId, result)).toEqual({
    status,
  });
  expect((await models.NoteCellExecution.findById(saved.executionId)).status).toBe(status);
});

test('rejects another conversation and preserves cancellation event history', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'code');
  await expect(lifecycle.finish('another-conversation', saved.executionId, {})).rejects.toThrow(
    'Execution not found',
  );
  await models.NoteExecutionEvent.create({
    executionId: saved.executionId,
    conversationId: 'test-conversation',
    sequence: 2,
    eventType: 'cancel_requested',
    status: 'running',
  });
  await lifecycle.finish('test-conversation', saved.executionId, {
    success: false,
    cancelled: true,
  });
  const events = await models.NoteExecutionEvent.find({ executionId: saved.executionId }).sort({
    sequence: 1,
  });
  expect(events.map((event: { eventType: string }) => event.eventType)).toEqual([
    'running',
    'cancel_requested',
    'cancelled',
  ]);
});

test('updates existing cell in place when targetCellId is provided', async () => {
  const initial = await lifecycle.start('test-conversation', 'test-user', 'x <- 1');
  await lifecycle.finish('test-conversation', initial.executionId, {
    success: false,
    error: 'syntax error',
  });

  // Update in place
  const updated = await lifecycle.start(
    'test-conversation',
    'test-user',
    'x <- 2',
    180,
    initial.cellId,
  );
  expect(updated.cellId).toBe(initial.cellId);
  expect(updated.revisionId).not.toBe(initial.revisionId);
  expect(updated.executionId).not.toBe(initial.executionId);

  const revisions = await models.NoteCellRevision.find({ cellId: initial.cellId }).sort({
    revision: 1,
  });
  expect(revisions).toHaveLength(2);
  expect(revisions[0].revision).toBe(1);
  expect(revisions[0].content).toBe('x <- 1');
  expect(revisions[1].revision).toBe(2);
  expect(revisions[1].content).toBe('x <- 2');

  const executions = await models.NoteCellExecution.find({ cellId: initial.cellId }).sort({
    attempt: 1,
  });
  expect(executions).toHaveLength(2);
  expect(executions[0].attempt).toBe(1);
  expect(executions[1].attempt).toBe(2);

  const cell = await models.NoteCell.findById(initial.cellId);
  expect(String(cell.latestRevisionId)).toBe(updated.revisionId);
  expect(String(cell.latestExecutionId)).toBe(updated.executionId);
});

describe('agent cells run through OmicsBase', () => {
  const bridge = jest.fn(async () => {});
  const execute = jest.fn();
  const run = createAgentCellRunner({
    lifecycle,
    resolveUser: async (conversationId) => (conversationId === 'note' ? 'alice' : null),
    bridgeConversationFiles: bridge,
    executeOnEngine: execute,
  });
  afterEach(() => jest.clearAllMocks());

  test('saves the cell, runs it on the engine under its execution and saves the result', async () => {
    execute.mockResolvedValue({
      success: true,
      stdout: '42',
      markdown: '[1] 42',
      run_dir: 'runs/a',
      plots: ['http://engine/projects/note/runs/a/plots/1.png'],
    });
    const text = await run({ conversationId: 'note', code: 'print(42)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(bridge).toHaveBeenCalledWith('note', 'alice');
    expect(execute).toHaveBeenCalledWith({
      code: 'print(42)',
      threadId: 'note',
      executionId: String(execution._id),
      timeoutSeconds: 600,
    });
    expect(execution.status).toBe('completed');
    expect(execution.user).toBe('alice');
    expect(await models.NoteExecutionArtifact.countDocuments({ executionId: execution._id })).toBe(
      2,
    );
    expect(text).toBe(
      `<!-- noteCell cellId=${execution.cellId} executionId=${execution._id} status=completed -->\n` +
        `[cell_id: "${execution.cellId}"]\n[1] 42`,
    );
  });

  test('rerunning a cell by its id adds a revision to the same cell', async () => {
    execute.mockResolvedValue({ success: true, markdown: 'ok' });
    await run({ conversationId: 'note', code: 'x <- 1' });
    const cell = await models.NoteCell.findOne({ conversationId: 'note' });
    await run({ conversationId: 'note', code: 'x <- 2', cellId: ` ${cell._id} ` });
    expect(await models.NoteCell.countDocuments({ conversationId: 'note' })).toBe(1);
    expect(await models.NoteCellRevision.countDocuments({ cellId: cell._id })).toBe(2);
  });

  test('a note that cannot be found is not run', async () => {
    const text = await run({ conversationId: 'missing', code: 'print(1)' });
    expect(text).toBe('Could not save the code cell; R was not executed: the note was not found');
    expect(execute).not.toHaveBeenCalled();
    expect(await models.NoteCellExecution.countDocuments({})).toBe(0);
  });

  test('an engine that fails or times out closes the cell with that status', async () => {
    execute.mockRejectedValueOnce(
      Object.assign(new Error('Cell execution timed out'), { code: 'TIMED_OUT' }),
    );
    const text = await run({ conversationId: 'note', code: 'Sys.sleep(999)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(execution.status).toBe('timed_out');
    expect(text).toContain('status=timed_out');
    expect(text).toContain('Execution failed: Cell execution timed out');
  });
});
