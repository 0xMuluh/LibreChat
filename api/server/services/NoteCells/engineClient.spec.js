process.env.NOTEKERNEL_URL = 'http://user:pass@engine.test:8001/proxied/';
process.env.OMICSBASE_ENGINE_SECRET = 'test-secret';

const {
  startExecution,
  getExecutionStatus,
  signalCancel,
  noteHasDataFile,
  checkEngineHealth,
  engineUnreachableError,
  ENGINE_HOST,
} = require('./engineClient');

const BASE = 'http://user:pass@engine.test:8001/proxied';
const UNREACHABLE =
  'Could not reach the notes engine at engine.test:8001. Check that the server is running and that ENGINE_URL in ~/omicsbase/.env is right, then run the cell again.';

/** The error Node's fetch throws when no answer came: "fetch failed" with the reason as cause. */
function fetchFailed(code) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

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
    expect(url).toBe(`${BASE}/api/execute`);
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
    expect(url).toBe(`${BASE}/api/executions/e1?thread_id=note+1&offset=7`);
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

  it.each([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('says the engine could not be reached when starting a cell fails with %s', async (code) => {
    const cause = fetchFailed(code);
    global.fetch.mockRejectedValue(cause);
    const error = await startExecution({ code: '1', threadId: 'note-1', executionId: 'e1' }).catch(
      (err) => err,
    );
    expect(error.message).toBe(UNREACHABLE);
    expect(error.code).toBe('ENGINE_UNREACHABLE');
    expect(error.cause).toBe(cause);
  });

  it('names only the host of the engine, never its credentials or path', () => {
    expect(ENGINE_HOST).toBe('engine.test:8001');
    const { message } = engineUnreachableError(new Error('Engine HTTP 502'));
    expect(message).toBe(UNREACHABLE);
    expect(message).not.toMatch(/user|pass|proxied|test-secret/);
  });

  it('says the same for a bare "fetch failed" and for a request that timed out', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(getExecutionStatus({ threadId: 'note-1', executionId: 'e1' })).rejects.toThrow(
      UNREACHABLE,
    );
    global.fetch.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(getExecutionStatus({ threadId: 'note-1', executionId: 'e1' })).rejects.toThrow(
      UNREACHABLE,
    );
  });

  it("says it when the note's files cannot be checked", async () => {
    global.fetch.mockRejectedValue(fetchFailed('ECONNREFUSED'));
    await expect(noteHasDataFile('note-1', 'counts.csv')).rejects.toThrow(UNREACHABLE);
  });

  it('leaves other errors as they are', async () => {
    global.fetch.mockRejectedValue(new Error('boom'));
    await expect(
      startExecution({ code: '1', threadId: 'note-1', executionId: 'e1' }),
    ).rejects.toThrow('boom');
  });

  describe('health check', () => {
    it('answers null when the engine is up, asking /health without the secret', async () => {
      global.fetch.mockResolvedValue(json(200, { status: 'ok' }));
      expect(await checkEngineHealth()).toBeNull();
      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe(`${BASE}/health`);
      expect(options.headers).toBeUndefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('answers the reason when the engine cannot be reached', async () => {
      global.fetch.mockRejectedValue(fetchFailed('ECONNREFUSED'));
      expect(await checkEngineHealth()).toBe('ECONNREFUSED');
    });

    it('answers the HTTP status when /health is refused or missing', async () => {
      global.fetch.mockResolvedValue(json(404, {}));
      expect(await checkEngineHealth()).toBe('HTTP 404 from /health');
    });
  });

  it('still signals a cancel by thread and execution', async () => {
    global.fetch.mockResolvedValue(json(200, {}));
    await signalCancel('note-1', 'e1');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/cancel`);
    expect(JSON.parse(options.body)).toEqual({ thread_id: 'note-1', execution_id: 'e1' });
  });
});
