import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { NoteEngineResult, NoteEngineStatus } from './contracts';
import { buildNoteArtifacts, createAgentCellRunner, createNoteAgentLifecycle } from './agent';
import { createEngineRunner, CANCELLED_MESSAGE, INTERRUPTED_MESSAGE } from './runner';
import models from '../../../../api/server/services/NoteCells/models';
import { createEventStore } from './events';
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

test('registers each file the run wrote once, as a download', () => {
  const execution = {
    _id: new mongoose.Types.ObjectId(),
    conversationId: 'convo',
    user: 'user',
  };
  const engine = 'http://engine/projects/convo';
  const artifacts = buildNoteArtifacts(execution, {
    run_dir: 'runs/r1',
    plots: [`${engine}/runs/r1/plots/1.png`],
    files: [
      { path: 'results/summary.csv', bytes: 12288, url: `${engine}/results/summary.csv` },
      { path: 'report.pdf', bytes: 2048 },
      { path: 'fits/model.rds', bytes: 900, url: `${engine}/fits/model.rds` },
      { path: 'counts.h5ad', bytes: 4096, url: `${engine}/counts.h5ad` },
      { path: 'unknown.xyz', url: `${engine}/unknown.xyz` },
      { path: 'my results.tsv', bytes: 5, url: `${engine}/my%20results.tsv` },
      { url: `${engine}/tree%20final.nwk`, bytes: 7 },
      // Already a plot, a repeat, and paths that leave the note folder.
      { path: 'runs/r1/plots/1.png', bytes: 10, url: `${engine}/runs/r1/plots/1.png` },
      { path: 'report.pdf', bytes: 2048 },
      { path: '../other/secret.csv', bytes: 1 },
      { path: '/etc/passwd', bytes: 1 },
    ],
  });
  const files = artifacts.filter((artifact) => artifact.artifactType === 'file');
  expect(
    files.map(({ relativePath, mimeType, byteSize }) => [relativePath, mimeType, byteSize]),
  ).toEqual([
    ['results/summary.csv', 'text/csv', 12288],
    ['report.pdf', 'application/octet-stream', 2048],
    ['fits/model.rds', 'application/x-r-rds', 900],
    ['counts.h5ad', 'application/x-hdf5', 4096],
    ['unknown.xyz', 'application/octet-stream', 0],
    ['my results.tsv', 'text/tab-separated-values', 5],
    ['tree final.nwk', 'text/plain', 7],
  ]);
  expect(files.every((file) => file.executionId === execution._id && file.user === 'user')).toBe(
    true,
  );
});

test('saves file artifacts and whether the engine left files out', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'write.csv(x, "x.csv")');
  await lifecycle.finish('test-conversation', saved.executionId, {
    success: true,
    files: [{ path: 'x.csv', bytes: 10, url: 'http://engine/projects/test-conversation/x.csv' }],
    files_truncated: true,
  });
  const stored = await models.NoteExecutionArtifact.find({ executionId: saved.executionId });
  expect(stored.map((artifact) => [artifact.artifactType, artifact.relativePath])).toEqual([
    ['file', 'x.csv'],
  ]);
  expect((await models.NoteCellExecution.findById(saved.executionId)).filesTruncated).toBe(true);
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
    'tool-call_2',
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
  expect(cell.blockKey).toBe('tool-call_2');
});

test('a new cell is stored under the block key it is started with', async () => {
  const saved = await lifecycle.start(
    'test-conversation',
    'test-user',
    'x <- 1',
    600,
    undefined,
    'tool-call_1',
  );
  expect((await models.NoteCell.findById(saved.cellId)).blockKey).toBe('tool-call_1');
  const execution = await models.NoteCellExecution.findById(saved.executionId);
  expect(execution.timeoutSeconds).toBe(600);
});

test('stores the book references and the wording of each ending', async () => {
  const done = await lifecycle.start('test-conversation', 'test-user', 'code');
  const bookRefs = { sections: [{ book: 'OMA', title: 'Alpha diversity' }], missing: [] };
  await lifecycle.finish('test-conversation', done.executionId, {
    success: true,
    book_refs: bookRefs,
  });
  expect((await models.NoteCellExecution.findById(done.executionId)).bookRefs).toEqual(bookRefs);

  const timedOut = await lifecycle.start('test-conversation', 'test-user', 'code', 600);
  await lifecycle.finish('test-conversation', timedOut.executionId, {
    success: false,
    timed_out: true,
    error: 'Cell execution timed out',
  });
  expect((await models.NoteCellExecution.findById(timedOut.executionId)).error).toBe(
    'Stopped after 10:00. R was restarted, so objects made since the session was last saved are gone. Run the earlier cells again to recreate them.',
  );

  const safetyStop = await lifecycle.start('test-conversation', 'test-user', 'code', 600);
  await lifecycle.finish('test-conversation', safetyStop.executionId, {
    success: false,
    timed_out: true,
    stopped_after_seconds: 1200,
  });
  expect((await models.NoteCellExecution.findById(safetyStop.executionId)).error).toMatch(
    /^Stopped after 20:00\. /,
  );

  const cancelledWhileRunning = await lifecycle.start('test-conversation', 'test-user', 'code');
  await models.NoteCellExecution.updateOne(
    { _id: cancelledWhileRunning.executionId },
    { $set: { rStartedAt: new Date() } },
  );
  await lifecycle.finish('test-conversation', cancelledWhileRunning.executionId, {
    success: false,
    cancelled: true,
  });
  expect((await models.NoteCellExecution.findById(cancelledWhileRunning.executionId)).error).toBe(
    CANCELLED_MESSAGE,
  );

  const cancelledWhileWaiting = await lifecycle.start('test-conversation', 'test-user', 'code');
  await lifecycle.finish('test-conversation', cancelledWhileWaiting.executionId, {
    success: false,
    cancelled: true,
  });
  expect((await models.NoteCellExecution.findById(cancelledWhileWaiting.executionId)).error).toBe(
    'Cancelled.',
  );
});

test('a cancel the user asked for stands when the engine result arrives after it', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'code');
  await models.NoteCellExecution.updateOne(
    { _id: saved.executionId },
    { $set: { cancelRequested: true } },
  );
  expect(await lifecycle.finish('test-conversation', saved.executionId, { success: true })).toEqual(
    { status: 'cancelled' },
  );
});

test('a cancelled run keeps the console text read while it ran', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'code');
  await models.NoteCellExecution.updateOne(
    { _id: saved.executionId },
    { $set: { stdout: 'Working, second 1\nWorking, second 2\n', rStartedAt: new Date() } },
  );
  await lifecycle.finish('test-conversation', saved.executionId, {
    success: false,
    cancelled: true,
    stdout: '[Kernel Cancelled]: Cell execution cancelled',
  });
  const execution = await models.NoteCellExecution.findById(saved.executionId);
  expect(execution.status).toBe('cancelled');
  expect(execution.stdout).toBe('Working, second 1\nWorking, second 2\n');
});

test('an interrupted run fails with the restart wording and keeps the console read so far', async () => {
  const saved = await lifecycle.start('test-conversation', 'test-user', 'code');
  await models.NoteCellExecution.updateOne(
    { _id: saved.executionId },
    { $set: { stdout: 'half way', phase: 'interrupted' } },
  );
  expect(
    await lifecycle.finish('test-conversation', saved.executionId, {
      success: false,
      interrupted: true,
      error: INTERRUPTED_MESSAGE,
    }),
  ).toEqual({ status: 'failed' });
  const execution = await models.NoteCellExecution.findById(saved.executionId);
  expect(execution.error).toBe('Interrupted by a server restart. Run the cell again.');
  expect(execution.phase).toBe('interrupted');
  expect(execution.stdout).toBe('half way');
  const last = await models.NoteExecutionEvent.findOne({ executionId: saved.executionId }).sort({
    sequence: -1,
  });
  expect(last.payload).toEqual({ error: INTERRUPTED_MESSAGE });
});

describe('agent cells run through OmicsBase', () => {
  const bridge = jest.fn(async () => {});
  const start = jest.fn(async () => ({ phase: 'starting_r' as const }));
  const status = jest.fn<Promise<NoteEngineStatus | null>, []>();
  const cancelExecution = jest.fn(async () => {});
  const track = jest.fn();
  const run = createAgentCellRunner({
    lifecycle,
    resolveUser: async (conversationId) => (conversationId === 'note' ? 'alice' : null),
    bridgeConversationFiles: bridge,
    engine: createEngineRunner(
      {
        models,
        startExecution: start,
        getExecutionStatus: status,
        signalCancel: jest.fn(async () => {}),
        pollSleep: () => new Promise((resolve) => setImmediate(resolve)),
      },
      createEventStore(models).appendEvent,
    ),
    cancelExecution,
    track,
  });
  const engineReturns = (result: NoteEngineResult) =>
    status.mockResolvedValue({ phase: 'done', done: true, result });
  afterEach(() => jest.clearAllMocks());

  test('saves the cell, runs it on the engine under its execution and saves the result', async () => {
    engineReturns({
      success: true,
      stdout: '42',
      markdown: '[1] 42',
      run_dir: 'runs/a',
      plots: ['http://engine/projects/note/runs/a/plots/1.png'],
      book_refs: { sections: [] },
    });
    const text = await run({ conversationId: 'note', code: 'print(42)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(bridge).toHaveBeenCalledWith('note', 'alice');
    expect(start).toHaveBeenCalledWith({
      code: 'print(42)',
      threadId: 'note',
      executionId: String(execution._id),
      timeoutSeconds: 600,
    });
    expect(execution.status).toBe('completed');
    expect(execution.user).toBe('alice');
    expect(execution.phase).toBe('done');
    expect(execution.bookRefs).toEqual({ sections: [] });
    expect(await models.NoteExecutionArtifact.countDocuments({ executionId: execution._id })).toBe(
      2,
    );
    expect(text).toBe(
      `<!-- noteCell cellId=${execution.cellId} executionId=${execution._id} status=completed -->\n` +
        `[cell_id: "${execution.cellId}"]\n[1] 42`,
    );
    const events = await models.NoteExecutionEvent.find({ executionId: execution._id }).sort({
      sequence: 1,
    });
    expect(
      events.map((event: { eventType: string; payload?: { phase?: string } }) =>
        event.eventType === 'phase' ? event.payload?.phase : event.eventType,
      ),
    ).toEqual(['running', 'preparing_files', 'starting_r', 'done', 'completed']);
    expect(events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  test('tells the agent which files the run wrote, without changing the saved output', async () => {
    engineReturns({
      success: true,
      markdown: 'done',
      files: [
        { path: 'out/a b.csv', bytes: 3, url: 'http://engine/projects/note/out/a%20b.csv' },
        { path: 'fig.pdf', bytes: 9, url: 'http://engine/projects/note/fig.pdf' },
      ],
      files_truncated: true,
    });
    const text = await run({ conversationId: 'note', code: 'write.csv(x, "out/a b.csv")' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(text).toMatch(
      /\ndone\n\nFiles written \(offered for download under the cell\): out\/a b\.csv, fig\.pdf, and more$/,
    );
    expect(execution.markdown).toBe('done');
    expect(execution.filesTruncated).toBe(true);
  });

  test('the cell exists under the tool-call key while it runs', async () => {
    const seenWhileRunning: string[] = [];
    status.mockImplementation(async () => {
      const cell = await models.NoteCell.findOne({
        conversationId: 'note',
        blockKey: 'tool-call_abc',
      });
      seenWhileRunning.push(String(cell.latestExecutionId));
      return { phase: 'done', done: true, result: { success: true, markdown: 'ok' } };
    });
    await run({ conversationId: 'note', code: 'x <- 1', toolCallId: 'call_abc' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(seenWhileRunning).toEqual([String(execution._id)]);
    expect(track).toHaveBeenCalledWith(String(execution._id), expect.any(Promise));
  });

  test('rerunning a cell by its id adds a revision to the same cell', async () => {
    engineReturns({ success: true, markdown: 'ok' });
    await run({ conversationId: 'note', code: 'x <- 1' });
    const cell = await models.NoteCell.findOne({ conversationId: 'note' });
    await run({ conversationId: 'note', code: 'x <- 2', cellId: ` ${cell._id} ` });
    expect(await models.NoteCell.countDocuments({ conversationId: 'note' })).toBe(1);
    expect(await models.NoteCellRevision.countDocuments({ cellId: cell._id })).toBe(2);
  });

  test('a note that cannot be found is not run', async () => {
    const text = await run({ conversationId: 'missing', code: 'print(1)' });
    expect(text).toBe('Could not save the code cell; R was not executed: the note was not found');
    expect(start).not.toHaveBeenCalled();
    expect(await models.NoteCellExecution.countDocuments({})).toBe(0);
  });

  test('files that cannot be copied close the cell without running R', async () => {
    bridge.mockRejectedValueOnce(new Error('Attachment permission denied'));
    const text = await run({ conversationId: 'note', code: 'print(1)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(start).not.toHaveBeenCalled();
    expect(execution.status).toBe('failed');
    expect(execution.phase).toBe('preparing_files');
    expect(text).toContain('status=failed');
    expect(text).toContain('R was not executed: Attachment permission denied');
  });

  test('a cell the engine timed out closes with that status and wording', async () => {
    engineReturns({ success: false, timed_out: true, markdown: 'Cell execution timed out' });
    const text = await run({ conversationId: 'note', code: 'Sys.sleep(999)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(execution.status).toBe('timed_out');
    expect(execution.error).toMatch(/^Stopped after 10:00\. R was restarted/);
    expect(text).toContain('status=timed_out');
    expect(text).toContain('Cell execution timed out');
  });

  test('an engine that cannot be reached closes the cell as failed', async () => {
    start.mockRejectedValueOnce(new Error('Engine HTTP 503: down'));
    const text = await run({ conversationId: 'note', code: 'print(1)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(execution.status).toBe('failed');
    expect(text).toContain('status=failed');
    expect(text).toContain('Execution failed: Engine HTTP 503: down');
  });

  test('a run the engine lost closes the cell as interrupted', async () => {
    status.mockResolvedValue(null);
    const text = await run({ conversationId: 'note', code: 'print(1)' });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(execution.status).toBe('failed');
    expect(execution.phase).toBe('interrupted');
    expect(text).toContain(INTERRUPTED_MESSAGE);
  });

  test('stopping the reply cancels the running cell on the engine', async () => {
    const controller = new AbortController();
    let cancelled = false;
    status.mockImplementation(async () =>
      cancelled
        ? {
            phase: 'done',
            done: true,
            result: { success: false, cancelled: true, markdown: 'Cell execution cancelled' },
          }
        : { phase: 'running', started_at: '2026-11-22T10:00:00Z' },
    );
    cancelExecution.mockImplementationOnce(async () => {
      cancelled = true;
    });
    const pending = run({
      conversationId: 'note',
      code: 'Sys.sleep(999)',
      signal: controller.signal,
    });
    while (!status.mock.calls.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    const text = await pending;
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(cancelExecution).toHaveBeenCalledWith(
      'note',
      'alice',
      String(execution.cellId),
      String(execution._id),
    );
    expect(execution.status).toBe('cancelled');
    expect(execution.error).toBe(CANCELLED_MESSAGE);
    expect(text).toContain('status=cancelled');
  });

  test('a reply stopped before the engine call still cancels the cell', async () => {
    engineReturns({ success: false, cancelled: true, markdown: 'cancelled' });
    await run({ conversationId: 'note', code: 'print(1)', signal: AbortSignal.abort() });
    const execution = await models.NoteCellExecution.findOne({ conversationId: 'note' });
    expect(cancelExecution).toHaveBeenCalledWith(
      'note',
      'alice',
      String(execution.cellId),
      String(execution._id),
    );
  });
});
