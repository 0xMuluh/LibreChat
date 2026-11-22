import { createExecutionWorker } from './worker';

function makeExecution(status = 'queued') {
  return {
    _id: 'execution-1',
    cellId: 'cell-1',
    revisionId: 'revision-1',
    conversationId: 'conversation-1',
    user: 'user-1',
    status,
    attempt: 1,
    timeoutSeconds: 600,
    save: jest.fn(async () => undefined),
  };
}

function makeWorker({
  execution = makeExecution(),
  open = [] as { _id: string }[],
  bridge = jest.fn(async () => undefined),
} = {}) {
  const runner = {
    setPhase: jest.fn(async () => undefined),
    run: jest.fn(async () => ({ success: true, stdout: '42' })),
    resume: jest.fn(async () => ({ success: true, stdout: 'resumed' })),
  };
  const finish = jest.fn(async () => ({ status: 'completed' as const }));
  const appendEvent = jest.fn(async () => 1);
  const models = {
    NoteCellExecution: {
      findById: jest.fn(async () => execution),
      find: jest.fn(() => ({ select: () => ({ lean: async () => open }) })),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    },
    NoteCellRevision: { findById: jest.fn(async () => ({ content: 'plot(1)' })) },
  };
  const worker = createExecutionWorker(
    {
      models,
      bridgeConversationFiles: bridge,
    } as never,
    appendEvent,
    runner,
    finish,
  );
  return { worker, runner, finish, appendEvent, execution, bridge, models };
}

test('copies the files, runs the cell through the runner and saves its result', async () => {
  const { worker, runner, finish, appendEvent, execution, bridge } = makeWorker();
  const order: string[] = [];
  runner.setPhase.mockImplementation(async () => void order.push('phase'));
  bridge.mockImplementation(async () => void order.push('files'));
  runner.run.mockImplementation(async () => {
    order.push('run');
    return { success: true, stdout: '42' };
  });

  await worker.enqueueExecution('execution-1');

  expect(order).toEqual(['phase', 'files', 'run']);
  expect(execution.status).toBe('running');
  expect(appendEvent).toHaveBeenCalledWith('execution-1', 'conversation-1', 'running', 'running');
  expect(runner.setPhase).toHaveBeenCalledWith('execution-1', 'conversation-1', 'preparing_files');
  expect(runner.run).toHaveBeenCalledWith({
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    timeoutSeconds: 600,
    code: 'plot(1)',
  });
  expect(finish).toHaveBeenCalledWith('conversation-1', 'execution-1', {
    success: true,
    stdout: '42',
  });
  expect(worker.waitForExecution('execution-1')).toBeUndefined();
});

test('does not execute R when attachment preparation fails', async () => {
  const { worker, runner, finish } = makeWorker({
    bridge: jest.fn(async () => {
      throw new Error('Attachment permission denied');
    }),
  });
  await worker.enqueueExecution('execution-1');
  expect(runner.run).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith('conversation-1', 'execution-1', {
    success: false,
    error: 'Attachment permission denied',
    markdown: 'Execution failed: Attachment permission denied',
  });
});

test('an engine error closes the cell as failed', async () => {
  const { worker, runner, finish } = makeWorker();
  runner.run.mockRejectedValue(new Error('Engine HTTP 500: boom'));
  await worker.enqueueExecution('execution-1');
  expect(finish).toHaveBeenCalledWith(
    'conversation-1',
    'execution-1',
    expect.objectContaining({ success: false, error: 'Engine HTTP 500: boom' }),
  );
});

test('a run already followed is not started twice', async () => {
  const { worker, runner } = makeWorker();
  const first = worker.enqueueExecution('execution-1');
  expect(worker.enqueueExecution('execution-1')).toBe(first);
  expect(worker.resumeExecution('execution-1')).toBe(first);
  await first;
  expect(runner.run).toHaveBeenCalledTimes(1);
  expect(runner.resume).not.toHaveBeenCalled();
});

test('resuming follows the run without copying files or starting it again', async () => {
  const { worker, runner, finish, bridge, execution } = makeWorker({
    execution: makeExecution('running'),
  });
  await worker.resumeExecution('execution-1');
  expect(bridge).not.toHaveBeenCalled();
  expect(runner.run).not.toHaveBeenCalled();
  expect(execution.save).not.toHaveBeenCalled();
  expect(runner.resume).toHaveBeenCalledWith({
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    timeoutSeconds: 600,
  });
  expect(finish).toHaveBeenCalledWith('conversation-1', 'execution-1', {
    success: true,
    stdout: 'resumed',
  });
});

test('a finished run is left alone', async () => {
  const { worker, runner, finish } = makeWorker({ execution: makeExecution('completed') });
  await worker.resumeExecution('execution-1');
  expect(runner.resume).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});

test('the restart sweep resumes every run still queued or running', async () => {
  const { worker, runner } = makeWorker({
    execution: makeExecution('running'),
    open: [{ _id: 'execution-1' }, { _id: 'execution-2' }],
  });
  expect(await worker.sweepExecutions()).toBe(2);
  await Promise.all([
    worker.waitForExecution('execution-1'),
    worker.waitForExecution('execution-2'),
  ]);
  expect(runner.resume).toHaveBeenCalledTimes(2);
});

test('the restart sweep closes old runs as interrupted without asking the engine', async () => {
  const { worker, models } = makeWorker({ execution: makeExecution('running'), open: [] });
  await worker.sweepExecutions();
  const [filter, update] = models.NoteCellExecution.updateMany.mock.calls[0] as unknown as [
    { status: unknown; createdAt: { $lt: Date } },
    { $set: Record<string, unknown> },
  ];
  expect(filter.status).toEqual({ $in: ['queued', 'running'] });
  expect(filter.createdAt.$lt.getTime()).toBeLessThan(Date.now() - 60 * 60 * 1000);
  expect(update.$set).toMatchObject({ status: 'failed', phase: 'interrupted' });
});

test('a run tracked from elsewhere is not picked up while it is followed', async () => {
  const { worker, runner } = makeWorker({ execution: makeExecution('running') });
  let done: () => void = () => {};
  worker.trackExecution(
    'execution-1',
    new Promise<void>((resolve) => {
      done = resolve;
    }),
  );
  const tracked = worker.resumeExecution('execution-1');
  expect(runner.resume).not.toHaveBeenCalled();
  done();
  await tracked;
  expect(worker.waitForExecution('execution-1')).toBeUndefined();
});
