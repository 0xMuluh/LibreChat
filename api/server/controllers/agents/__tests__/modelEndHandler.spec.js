jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@librechat/api', () => {
  const { getModelRefusalInfo } = jest.requireActual('@librechat/api');
  return {
    sendEvent: jest.fn(),
    emitEvent: jest.fn(),
    createToolExecuteHandler: jest.fn(),
    markSummarizationUsage: (usage) => usage,
    getModelRefusalInfo,
  };
});
jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));
jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
  runPreviewFinalize: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

const { ModelEndHandler, ModelStartHandler, contextualizeModelUsage } = require('../callbacks');

const buildGraph = () => ({
  getAgentContext: () => ({
    provider: 'vertexai',
    clientOptions: { model: 'gemini-3.1-flash-lite-preview' },
  }),
});

describe('ModelEndHandler — Vertex thoughtSignature capture (issue #13006 follow-up)', () => {
  it('leaves usage usable when graph context is unavailable', () => {
    const usage = { input_tokens: 10, output_tokens: 5 };

    expect(contextualizeModelUsage(usage, undefined, undefined)).toEqual(usage);
    expect(contextualizeModelUsage(usage, undefined, null)).toEqual(usage);
  });

  it('prefers the actually invoked fallback provider and model', () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    const result = contextualizeModelUsage(
      usage,
      {
        __invoked_provider: 'anthropic',
        __invoked_model: 'claude-fallback',
      },
      {
        provider: 'bedrock',
        agentId: 'agent-1',
        clientOptions: { model: 'configured-model' },
      },
    );

    expect(result).toEqual({
      ...usage,
      provider: 'anthropic',
      model: 'claude-fallback',
      agentId: 'agent-1',
    });
  });

  it('prefers provider-reported model metadata over the invoked fallback model', () => {
    expect(
      contextualizeModelUsage(
        { input_tokens: 10, output_tokens: 5 },
        { ls_model_name: 'reported-model', __invoked_model: 'fallback-model' },
        { clientOptions: { model: 'configured-model' } },
      ).model,
    ).toBe('reported-model');
  });

  it('maps non-empty signatures onto tool_call_ids in order', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          tool_calls: [
            { id: 'tc_a', name: 'a', args: {} },
            { id: 'tc_b', name: 'b', args: {} },
          ],
          additional_kwargs: { signatures: ['SIG_A', '', 'SIG_B'] },
        },
      },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({ tc_a: 'SIG_A', tc_b: 'SIG_B' });
    expect(collectedUsage).toHaveLength(1);
  });

  it('accumulates per-id across multiple model_end events (multi-step tool turn)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG_step1'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );
    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc_step2', name: 'b', args: {} }],
          additional_kwargs: { signatures: ['SIG_step2'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({
      tc_step1: 'SIG_step1',
      tc_step2: 'SIG_step2',
    });
  });

  it('is a no-op for signatures when collectedThoughtSignatures is null', async () => {
    const collectedUsage = [];
    const handler = new ModelEndHandler(collectedUsage, null);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: { signatures: ['SIG'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedUsage).toHaveLength(1);
  });

  it('does not store anything when signatures field is missing (non-Vertex providers)', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          tool_calls: [{ id: 'tc1', name: 'a', args: {} }],
          additional_kwargs: {},
        },
      },
      { ls_model_name: 'gpt-4', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('does not store anything when tool_calls is missing', async () => {
    const collectedUsage = [];
    const collectedThoughtSignatures = {};
    const handler = new ModelEndHandler(collectedUsage, collectedThoughtSignatures);

    await handler.handle(
      'on_chat_model_end',
      {
        output: {
          usage_metadata: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          additional_kwargs: { signatures: ['SIG_orphan'] },
        },
      },
      { ls_model_name: 'g', user_id: 'u' },
      buildGraph(),
    );

    expect(collectedThoughtSignatures).toEqual({});
  });

  it('tags the producing agent on collected + emitted usage for per-endpoint pricing', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);
    const graph = {
      getAgentContext: () => ({
        provider: 'openai',
        agentId: 'agent_sub',
        clientOptions: { model: 'gpt-4' },
      }),
    };

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gpt-4', run_id: 'r1', user_id: 'u1' },
      graph,
    );

    expect(collectedUsage[0].agentId).toBe('agent_sub');
    expect(collectedUsage[0].provider).toBe('openai');
    expect(collectedUsage[0].model).toBe('gpt-4');
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent_sub' }));
  });

  it('leaves usage untagged when the graph context has no agentId (single-endpoint)', async () => {
    const collectedUsage = [];
    const emitUsage = jest.fn();
    const handler = new ModelEndHandler(collectedUsage, null, emitUsage);

    await handler.handle(
      'on_chat_model_end',
      { output: { usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
      { ls_model_name: 'gemini-3.1-flash-lite-preview', run_id: 'r1', user_id: 'u1' },
      buildGraph(),
    );

    expect(collectedUsage[0].agentId).toBeUndefined();
    expect(emitUsage).toHaveBeenCalledWith(expect.objectContaining({ agentId: undefined }));
  });

  it('throws when collectedUsage is not an array (existing contract)', () => {
    expect(() => new ModelEndHandler(null)).toThrow('collectedUsage must be an array');
  });
});

describe('ModelStartHandler — model call latency', () => {
  const end = (handler, metadata, usage = { input_tokens: 5, output_tokens: 5 }) =>
    handler.handle(
      'on_chat_model_end',
      { output: usage ? { usage_metadata: usage } : {} },
      metadata,
      buildGraph(),
    );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the seconds between start and end on the collected usage', async () => {
    const collectedUsage = [];
    const starts = new ModelStartHandler();
    const handler = new ModelEndHandler(collectedUsage, null, null, starts);
    const metadata = { run_id: 'run-1', langgraph_checkpoint_ns: 'agent:task-1' };

    starts.handle('on_chat_model_start', {}, metadata);
    jest.setSystemTime(2500);
    await end(handler, metadata);

    expect(collectedUsage[0].latencySeconds).toBe(2.5);
  });

  it('pairs parallel calls by their graph task, not by arrival order', async () => {
    const collectedUsage = [];
    const starts = new ModelStartHandler();
    const handler = new ModelEndHandler(collectedUsage, null, null, starts);
    const first = { run_id: 'run-1', langgraph_checkpoint_ns: 'agent_a:task-1' };
    const second = { run_id: 'run-1', langgraph_checkpoint_ns: 'agent_b:task-2' };

    starts.handle('on_chat_model_start', {}, first);
    jest.setSystemTime(1000);
    starts.handle('on_chat_model_start', {}, second);
    jest.setSystemTime(3000);
    await end(handler, second);
    jest.setSystemTime(7000);
    await end(handler, first);

    expect(collectedUsage.map((usage) => usage.latencySeconds)).toEqual([2, 7]);
  });

  it('times each sequential call of one task from its own start', async () => {
    const collectedUsage = [];
    const starts = new ModelStartHandler();
    const handler = new ModelEndHandler(collectedUsage, null, null, starts);
    const metadata = { run_id: 'run-1', langgraph_node: 'agent' };

    starts.handle('on_chat_model_start', {}, metadata);
    jest.setSystemTime(1000);
    await end(handler, metadata);
    jest.setSystemTime(5000);
    starts.handle('on_chat_model_start', {}, metadata);
    jest.setSystemTime(5500);
    await end(handler, metadata);

    expect(collectedUsage.map((usage) => usage.latencySeconds)).toEqual([1, 0.5]);
  });

  it('leaves the latency out when no start was seen or no start handler is given', async () => {
    const collectedUsage = [];
    const metadata = { run_id: 'run-1', langgraph_node: 'agent' };

    await end(new ModelEndHandler(collectedUsage, null, null, new ModelStartHandler()), metadata);
    await end(new ModelEndHandler(collectedUsage), metadata);

    expect(collectedUsage).toHaveLength(2);
    expect(collectedUsage.every((usage) => !('latencySeconds' in usage))).toBe(true);
  });

  it('forgets the start of a call that reported no usage', async () => {
    const collectedUsage = [];
    const starts = new ModelStartHandler();
    const handler = new ModelEndHandler(collectedUsage, null, null, starts);
    const metadata = { run_id: 'run-1', langgraph_node: 'agent' };

    starts.handle('on_chat_model_start', {}, metadata);
    await end(handler, metadata, null);

    expect(collectedUsage).toHaveLength(0);
    expect(starts.startedAt.size).toBe(0);
  });
});
