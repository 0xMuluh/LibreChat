import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import models from '../../../../api/server/services/NoteCells/models';
import { createNoteService } from './service';
import { bindNoteThread } from './mcp';
import type { NoteEngineResult } from './contracts';

let mongo: MongoMemoryServer;
const bridge = jest.fn(async () => {});
const execute = jest.fn(async (): Promise<NoteEngineResult> => ({ success: true, stdout: '42' }));
const cancel = jest.fn(async () => {});
const artifact = jest.fn(async () => ({ buffer: Buffer.from('plot'), contentType: 'image/png' }));
const service = createNoteService({
  models,
  getConversationModel: () => undefined,
  bridgeConversationFiles: bridge,
  executeOnEngine: execute,
  fetchArtifactFromEngine: artifact,
  signalCancel: cancel,
  internalSecret: 'test-secret',
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
afterEach(async () => {
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
  jest.clearAllMocks();
  execute.mockImplementation(async () => ({ success: true, stdout: '42' }));
});

test('preserves cell identity, revisions, durable results and console artifact access', async () => {
  const cell = await service.findOrCreateCell({ conversationId: 'chat', userId: 'alice', messageId: 'msg', blockKey: 'block', content: 'print(42)' });
  const same = await service.findOrCreateCell({ conversationId: 'chat', userId: 'alice', messageId: 'msg', blockKey: 'block', content: 'ignored' });
  expect(same.id).toBe(cell.id);
  const revision = await service.appendRevision({ conversationId: 'chat', userId: 'alice', cellId: cell.id, content: '42' });
  expect(revision.revision).toBe(2);
  const execution = await service.executeCell({ conversationId: 'chat', userId: 'alice', cellId: cell.id });
  await service.waitForExecution(execution.id);
  const result = await service.getExecution('chat', 'alice', cell.id, execution.id);
  expect(result.status).toBe('completed');
  expect(result.stdout).toBe('42');
  expect(bridge).toHaveBeenCalledWith('chat', 'alice');
  const output = await service.getArtifactContent('chat', 'alice', cell.id, execution.id, result.artifacts[0].id);
  expect(output.buffer.toString()).toBe('42');
  expect(artifact).not.toHaveBeenCalled();
  await expect(service.getExecution('chat', 'bob', cell.id, execution.id)).rejects.toMatchObject({ status: 404 });
});

test('cancellation remains authoritative when engine success arrives afterward', async () => {
  let release: (result: NoteEngineResult) => void = () => { throw new Error('Engine not started'); };
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => { entered = resolve; });
  execute.mockImplementation(() => new Promise<NoteEngineResult>((resolve) => { release = resolve; entered(); }));
  const cell = await service.createCell({ conversationId: 'chat', userId: 'alice', content: 'Sys.sleep(10)' });
  const execution = await service.executeCell({ conversationId: 'chat', userId: 'alice', cellId: cell.id });
  await started;
  await service.cancelExecution('chat', 'alice', cell.id, execution.id);
  expect(cancel).toHaveBeenCalledWith('chat', execution.id);
  release({ success: true, stdout: 'late result' });
  await service.waitForExecution(execution.id);
  expect((await service.getExecution('chat', 'alice', cell.id, execution.id)).status).toBe('cancelled');
});

test('only the note execution tool receives the host conversation binding', () => {
  const input = { code: '42', thread_id: 'model-selected' };
  expect(bindNoteThread('notethreads', 'execute_r_cell', input, 'host-chat')).toEqual({ code: '42', thread_id: 'host-chat' });
  expect(bindNoteThread('another', 'execute_r_cell', input, 'host-chat')).toBe(input);
  expect(bindNoteThread('notethreads', 'other', input, 'host-chat')).toBe(input);
  expect(service.verifyInternalSecret('test-secret')).toBe(true);
  expect(service.verifyInternalSecret('wrong')).toBe(false);
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
  } as any;

  const fakeSharedLinkModel = {
    findOne: jest.fn((query) => ({
      select: () => ({
        lean: async () => {
          const matches = query.$or?.some(
            (c: any) =>
              c.shareId === 'share123' ||
              c.conversationId === 'share123' ||
              c.conversationId === 'convo1',
          );
          if (matches) {
            return { conversationId: 'convo1', user: 'alice', shareId: 'share123' };
          }
          return null;
        },
      }),
    })),
  } as any;

  const authService = createNoteService({
    models,
    getConversationModel: () => fakeConvoModel,
    getSharedLinkModel: () => fakeSharedLinkModel,
    bridgeConversationFiles: bridge,
    executeOnEngine: execute,
    fetchArtifactFromEngine: artifact,
    signalCancel: cancel,
    internalSecret: 'test-secret',
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

  // 5. Invalid shareId rejected
  await expect(
    authService.assertConversationAccess('badshare', undefined, { readOnly: true }),
  ).rejects.toMatchObject({
    status: 404,
  });
});
