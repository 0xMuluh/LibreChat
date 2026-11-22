process.env.NOTEKERNEL_URL = 'http://engine.test:8001/';
process.env.OMICSBASE_ENGINE_SECRET = 'test-secret';

const { startExecution, getExecutionStatus, signalCancel } = require('./engineClient');

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('NoteCells engine client', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('starts a cell without waiting for it', async () => {
    global.fetch.mockResolvedValue(json(202, { execution_id: 'e1', phase: 'waiting_for_slot' }));

    const started = await startExecution({
      code: 'print(1)',
      threadId: 'note-1',
      executionId: 'e1',
      timeoutSeconds: 600,
    });

    expect(started).toEqual({ execution_id: 'e1', phase: 'waiting_for_slot' });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://engine.test:8001/api/execute');
    expect(options.method).toBe('POST');
    expect(options.headers['X-Internal-Secret']).toBe('test-secret');
    expect(JSON.parse(options.body)).toEqual({
      code: 'print(1)',
      thread_id: 'note-1',
      execution_id: 'e1',
      timeout_seconds: 600,
      wait: false,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports an engine that refuses the cell', async () => {
    global.fetch.mockResolvedValue(json(503, { detail: 'busy' }));
    await expect(
      startExecution({ code: '1', threadId: 'note-1', executionId: 'e1' }),
    ).rejects.toThrow('Engine HTTP 503');
  });

  it('asks for the status of a run from an output offset', async () => {
    const status = { phase: 'running', output: 'abc', next_offset: 10, done: false };
    global.fetch.mockResolvedValue(json(200, status));

    expect(await getExecutionStatus({ threadId: 'note 1', executionId: 'e1', offset: 7 })).toEqual(
      status,
    );

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://engine.test:8001/api/executions/e1?thread_id=note+1&offset=7');
    expect(options.method).toBeUndefined();
    expect(options.headers['X-Internal-Secret']).toBe('test-secret');
  });

  it('answers null for a run the engine does not know', async () => {
    global.fetch.mockResolvedValue(json(404, { detail: 'unknown execution' }));
    expect(await getExecutionStatus({ threadId: 'note-1', executionId: 'gone' })).toBeNull();
  });

  it('reports other status errors', async () => {
    global.fetch.mockResolvedValue(json(500, { detail: 'boom' }));
    await expect(getExecutionStatus({ threadId: 'note-1', executionId: 'e1' })).rejects.toThrow(
      'Engine HTTP 500',
    );
  });

  it('still signals a cancel by thread and execution', async () => {
    global.fetch.mockResolvedValue(json(200, {}));
    await signalCancel('note-1', 'e1');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://engine.test:8001/api/cancel');
    expect(JSON.parse(options.body)).toEqual({ thread_id: 'note-1', execution_id: 'e1' });
  });
});
