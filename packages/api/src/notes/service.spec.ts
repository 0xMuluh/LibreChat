import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { NoteEngineResult, NoteEngineStatus } from './contracts';
import type { NoteDependencies } from './serviceTypes';
import models from '../../../../api/server/services/NoteCells/models';
import { bindNoteThread, isAgentCellTool } from './mcp';
import { createNoteService } from './service';

let mongo: MongoMemoryServer;
const bridge = jest.fn(async () => {});
const finished = (result: NoteEngineResult): NoteEngineStatus => ({
  phase: 'done',
  done: true,
  result,
});
const start = jest.fn(async () => ({ phase: 'starting_r' as const }));
const status = jest.fn(
  async (): Promise<NoteEngineStatus | null> => finished({ success: true, stdout: '42' }),
);
const cancel = jest.fn(async () => {});
const artifact = jest.fn(async () => ({ buffer: Buffer.from('plot'), contentType: 'image/png' }));
const service = createNoteService({
  models,
  getConversationModel: () => undefined,
  bridgeConversationFiles: bridge,
  startExecution: start,
  getExecutionStatus: status,
  pollSleep: () => new Promise((resolve) => setImmediate(resolve)),
  fetchArtifactFromEngine: artifact,
  signalCancel: cancel,
});

/** A run left behind by a server that stopped: on record, followed by no job. */
async function orphanExecution(fields: Record<string, unknown> = {}) {
  const cell = await service.createCell({ conversationId: 'chat', userId: 'alice', content: '1' });
  const execution = await models.NoteCellExecution.create({
    cellId: cell.id,
    revisionId: cell.latestRevisionId,
    conversationId: 'chat',
    user: 'alice',
    status: 'running',
    createdAt: new Date(Date.now() - 60000),
    ...fields,
  });
  return { cellId: cell.id, executionId: String(execution._id) };
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
  status.mockImplementation(async () => finished({ success: true, stdout: '42' }));
});

test('preserves cell identity, revisions, durable results and console artifact access', async () => {
  const cell = await service.findOrCreateCell({
    conversationId: 'chat',
    userId: 'alice',
    messageId: 'msg',
    blockKey: 'block',
    content: 'print(42)',
  });
  const same = await service.findOrCreateCell({
    conversationId: 'chat',
    userId: 'alice',
    messageId: 'msg',
    blockKey: 'block',
    content: 'ignored',
  });
  expect(same.id).toBe(cell.id);
  const revision = await service.appendRevision({
    conversationId: 'chat',
    userId: 'alice',
    cellId: cell.id,
    content: '42',
  });
  expect(revision.revision).toBe(2);
  const execution = await service.executeCell({
    conversationId: 'chat',
    userId: 'alice',
    cellId: cell.id,
  });
  await service.waitForExecution(execution.id);
  const result = await service.getExecution('chat', 'alice', cell.id, execution.id);
  expect(result.status).toBe('completed');
  expect(result.stdout).toBe('42');
  expect(bridge).toHaveBeenCalledWith('chat', 'alice');
  const output = await service.getArtifactContent(
    'chat',
    'alice',
    cell.id,
    execution.id,
    result.artifacts[0].id,
  );
  expect('buffer' in output ? output.buffer.toString() : null).toBe('42');
  expect(artifact).not.toHaveBeenCalled();
  await expect(service.getExecution('chat', 'bob', cell.id, execution.id)).rejects.toMatchObject({
    status: 404,
  });
});

test('cancellation remains authoritative when engine success arrives afterward', async () => {
  let release: (status: NoteEngineStatus) => void = () => {
    throw new Error('Engine not started');
  };
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  status.mockImplementation(
    () =>
      new Promise<NoteEngineStatus>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  const cell = await service.createCell({
    conversationId: 'chat',
    userId: 'alice',
    content: 'Sys.sleep(10)',
  });
  const execution = await service.executeCell({
    conversationId: 'chat',
    userId: 'alice',
    cellId: cell.id,
  });
  await started;
  await service.cancelExecution('chat', 'alice', cell.id, execution.id);
  expect(cancel).toHaveBeenCalledWith('chat', execution.id);
  release(finished({ success: true, stdout: 'late result' }));
  await service.waitForExecution(execution.id);
  expect((await service.getExecution('chat', 'alice', cell.id, execution.id)).status).toBe(
    'cancelled',
  );
});

test('a cell run by the user gets 600 seconds and reports phase, book references and server time', async () => {
  status.mockImplementation(async () =>
    finished({ success: true, stdout: '42', book_refs: { sections: [{ book: 'OMA' }] } }),
  );
  const cell = await service.createCell({ conversationId: 'chat', userId: 'alice', content: '42' });
  const execution = await service.executeCell({
    conversationId: 'chat',
    userId: 'alice',
    cellId: cell.id,
  });
  expect(execution.timeoutSeconds).toBe(600);
  expect(execution.phase).toBeNull();
  expect(execution.serverNow).toBeInstanceOf(Date);
  await service.waitForExecution(execution.id);
  expect(start).toHaveBeenCalledWith({
    code: '42',
    threadId: 'chat',
    executionId: execution.id,
    timeoutSeconds: 600,
  });
  const result = await service.getExecution('chat', 'alice', cell.id, execution.id);
  expect(result.status).toBe('completed');
  expect(result.phase).toBe('done');
  expect(result.phaseStartedAt).toBeInstanceOf(Date);
  expect(result.rStartedAt).toBeNull();
  expect(result.bookRefs).toEqual({ sections: [{ book: 'OMA' }] });
  const events = await service.listEvents('chat', 'alice', cell.id, execution.id);
  expect(
    events.map((event) => (event.eventType === 'phase' ? event.payload?.phase : event.eventType)),
  ).toEqual(['queued', 'running', 'preparing_files', 'starting_r', 'done', 'completed']);
});

test('an agent cell is found by its tool-call key with its latest execution', async () => {
  const ownedByAlice = {
    findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'c1', user: 'alice' }) }) }),
  } as unknown as ReturnType<NoteDependencies['getConversationModel']>;
  const agentService = createNoteService({
    models,
    getConversationModel: () => ownedByAlice,
    bridgeConversationFiles: bridge,
    startExecution: start,
    getExecutionStatus: status,
    fetchArtifactFromEngine: artifact,
    signalCancel: cancel,
  });
  const text = await agentService.runAgentCell({
    conversationId: 'chat',
    code: 'print(42)',
    toolCallId: 'call_1',
  });
  expect(text).toContain('status=completed');
  const cell = await agentService.getCellByBlockKey('chat', 'alice', 'tool-call_1');
  expect(cell.blockKey).toBe('tool-call_1');
  expect(cell.revision?.content).toBe('print(42)');
  expect(cell.latestExecution?.status).toBe('completed');
  expect(cell.latestExecution?.phase).toBe('done');
  expect(cell.latestExecution?.artifacts).toHaveLength(1);
  await expect(agentService.getCellByBlockKey('chat', 'bob', 'tool-call_1')).rejects.toMatchObject({
    status: 404,
  });
  await expect(agentService.getCellByBlockKey('chat', 'alice', 'tool-other')).rejects.toMatchObject(
    { status: 404 },
  );
});

test('the restart sweep closes runs the engine no longer knows as interrupted', async () => {
  status.mockResolvedValue(null);
  const { cellId, executionId } = await orphanExecution({ status: 'queued' });
  expect(await service.sweepExecutions()).toBe(1);
  await service.waitForExecution(executionId);
  const result = await service.getExecution('chat', 'alice', cellId, executionId);
  expect(result.status).toBe('failed');
  expect(result.phase).toBe('interrupted');
  expect(result.error).toBe('Interrupted by a server restart. Run the cell again.');
  expect(start).not.toHaveBeenCalled();
  // Idempotent: nothing is left to sweep and the record is not touched again.
  expect(await service.sweepExecutions()).toBe(0);
});

test('the restart sweep saves the result of a run that finished meanwhile', async () => {
  status.mockResolvedValue(finished({ success: true, stdout: 'done while away' }));
  const { cellId, executionId } = await orphanExecution();
  await service.sweepExecutions();
  await service.waitForExecution(executionId);
  const result = await service.getExecution('chat', 'alice', cellId, executionId);
  expect(result.status).toBe('completed');
  expect(result.stdout).toBe('done while away');
  expect(result.artifacts).toHaveLength(1);
});

test('the restart sweep keeps following a run that is still running', async () => {
  let running = true;
  status.mockImplementation(async () =>
    running
      ? { phase: 'running', output: 'tick', next_offset: 4 }
      : finished({ success: true, stdout: 'tick tock' }),
  );
  const { cellId, executionId } = await orphanExecution({ phase: 'running' });
  await service.sweepExecutions();
  while (status.mock.calls.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect((await service.getExecution('chat', 'alice', cellId, executionId)).status).toBe('running');
  running = false;
  await service.waitForExecution(executionId);
  const result = await service.getExecution('chat', 'alice', cellId, executionId);
  expect(result.status).toBe('completed');
  expect(result.stdout).toBe('tick tock');
});

test('asking for an orphaned run reconciles it without the sweep', async () => {
  status.mockResolvedValue(null);
  const { cellId, executionId } = await orphanExecution();
  expect((await service.getExecution('chat', 'alice', cellId, executionId)).status).toBe('running');
  await service.waitForExecution(executionId);
  const result = await service.getExecution('chat', 'alice', cellId, executionId);
  expect(result.status).toBe('failed');
  expect(result.phase).toBe('interrupted');
  expect(status).toHaveBeenCalledTimes(1);
});

test('a run just created is not taken for an orphan', async () => {
  const { cellId, executionId } = await orphanExecution({ createdAt: new Date() });
  await service.getExecution('chat', 'alice', cellId, executionId);
  expect(service.waitForExecution(executionId)).toBeUndefined();
  expect(status).not.toHaveBeenCalled();
});

test('the note execution and book search tools receive the host conversation binding', () => {
  const input = { code: '42', thread_id: 'model-selected' };
  expect(bindNoteThread('notethreads', 'execute_r_cell', input, 'host-chat')).toEqual({
    code: '42',
    thread_id: 'host-chat',
  });
  expect(
    bindNoteThread('notethreads', 'search_bioc_books', { query: 'alpha' }, 'host-chat'),
  ).toEqual({ query: 'alpha', thread_id: 'host-chat' });
  expect(bindNoteThread('another', 'search_bioc_books', input, 'host-chat')).toBe(input);
  expect(bindNoteThread('another', 'execute_r_cell', input, 'host-chat')).toBe(input);
  expect(bindNoteThread('notethreads', 'other', input, 'host-chat')).toBe(input);
});

test('only the note execution tool is run by OmicsBase itself', () => {
  expect(isAgentCellTool('notethreads', 'execute_r_cell')).toBe(true);
  expect(isAgentCellTool('notethreads', 'r_help')).toBe(false);
  expect(isAgentCellTool('another', 'execute_r_cell')).toBe(false);
});

test('assertConversationAccess handles owner and read-only shared link resolution', async () => {
  const fakeConvoModel = {
    findOne: jest.fn(({ conversationId, user }) => ({
      select: () => ({
        lean: async () => {
          if (conversationId === 'convo1' && user === 'alice') {
            return { _id: 'c1', user: 'alice' };
          }
          return null;
        },
      }),
    })),
  } as unknown as ReturnType<NoteDependencies['getConversationModel']>;

  const fakeSharedLinkModel = {
    findOne: jest.fn((query) => ({
      select: () => ({
        lean: async () => {
          if (query.shareId === 'share123') {
            return { conversationId: 'convo1', user: 'alice', shareId: 'share123' };
          }
          return null;
        },
      }),
    })),
  } as unknown as ReturnType<NonNullable<NoteDependencies['getSharedLinkModel']>>;

  const authService = createNoteService({
    models,
    getConversationModel: () => fakeConvoModel,
    getSharedLinkModel: () => fakeSharedLinkModel,
    bridgeConversationFiles: bridge,
    startExecution: start,
    getExecutionStatus: status,
    fetchArtifactFromEngine: artifact,
    signalCancel: cancel,
  });

  // 1. Owner can access (read or write)
  const ownerAccess = await authService.assertConversationAccess('convo1', 'alice');
  expect(ownerAccess).toEqual({ conversationId: 'convo1', userId: 'alice' });

  // 2. Non-owner without readOnly cannot access (e.g. mutation)
  await expect(
    authService.assertConversationAccess('convo1', 'bob', { readOnly: false }),
  ).rejects.toMatchObject({
    status: 404,
  });

  // 3. Non-owner with readOnly can access via active SharedLink
  const sharedAccess = await authService.assertConversationAccess('share123', 'bob', {
    readOnly: true,
  });
  expect(sharedAccess).toEqual({ conversationId: 'convo1', userId: 'alice', isShared: true });

  // 4. Unauthenticated viewer with readOnly can access via active SharedLink
  const anonAccess = await authService.assertConversationAccess('share123', undefined, {
    readOnly: true,
  });
  expect(anonAccess).toEqual({ conversationId: 'convo1', userId: 'alice', isShared: true });

  // 5. The note's own conversation id does not open its share to others
  await expect(
    authService.assertConversationAccess('convo1', 'bob', { readOnly: true }),
  ).rejects.toMatchObject({ status: 404 });

  // 6. Invalid shareId rejected
  await expect(
    authService.assertConversationAccess('badshare', undefined, { readOnly: true }),
  ).rejects.toMatchObject({
    status: 404,
  });
});

test('a share scope holds only the cells its messages reference', async () => {
  const shown = await service.createCell({ conversationId: 'chat', userId: 'alice' });
  const byToolCall = await service.createCell({
    conversationId: 'chat',
    userId: 'alice',
    blockKey: 'tool-call_2',
  });
  await service.createCell({ conversationId: 'chat', userId: 'alice', blockKey: 'tool-call_9' });
  await service.createCell({ conversationId: 'other', userId: 'alice', blockKey: 'tool-call_2' });
  const source = {
    conversationId: 'chat',
    user: 'alice',
    snapshotFiles: false,
    messages: [
      {
        content: [
          { type: 'tool_call', tool_call: { id: 'call_1', output: `[cell_id: "${shown.id}"]` } },
          { type: 'tool_call', tool_call: { id: 'call_2' } },
        ],
      },
    ],
  };
  const sharing = createNoteService({
    models,
    getConversationModel: () => undefined,
    getSharedLinkSource: async (shareId) => (shareId === 'share1' ? source : null),
    bridgeConversationFiles: bridge,
    startExecution: start,
    getExecutionStatus: status,
    fetchArtifactFromEngine: artifact,
    signalCancel: cancel,
  });

  const scope = await sharing.getShareScope('share1');
  expect([...(scope?.cellIds ?? [])].sort()).toEqual([shown.id, byToolCall.id].sort());
  expect(scope?.includeFiles).toBe(false);
  expect(await sharing.getShareScope('gone')).toBeNull();
});
