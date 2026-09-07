import type { ConversationDeletionDeps } from './deletion';
import { createConversationDeletionService } from './deletion';

describe('conversation deletion recovery', () => {
  it('reaches final dependent cleanup for an authorized retry with a missing root', async () => {
    const db = {
      deleteConvos: jest.fn().mockResolvedValue({
        acknowledged: true,
        deletedCount: 0,
        messages: { acknowledged: true, deletedCount: 0 },
        conversationIds: [],
      }),
      deleteMessages: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
      deleteToolCalls: jest.fn().mockResolvedValue({ acknowledged: true, deletedCount: 1 }),
    };
    const deleteConvoSharedLinksWithCleanup = jest
      .fn()
      .mockResolvedValue({ message: 'deleted', deletedCount: 1 });
    const deps = {
      db,
      subagentThreadTaskStore: {
        planCancellationForConversations: jest.fn().mockResolvedValue({ leases: [] }),
        cancelPlan: jest.fn().mockResolvedValue(undefined),
        withOwnerDeletionFence: jest.fn(),
      },
      GenerationJobManager: {
        getCleanupBlockingJobIdsForConversations: jest.fn().mockResolvedValue([]),
        getCleanupBlockingJobIdsForUser: jest.fn().mockResolvedValue([]),
        getJob: jest.fn().mockResolvedValue(null),
      },
      deleteAgentCheckpointScopes: jest.fn().mockResolvedValue(undefined),
      deleteConvoSharedLinksWithCleanup,
      isStopConfirmed: jest.fn(() => true),
      logger: { warn: jest.fn() },
    } as unknown as ConversationDeletionDeps;
    const service = createConversationDeletionService(deps);

    await service.deleteConversations(
      'owner-a',
      { conversationId: 'conversation-a' },
      'tenant-a',
      undefined,
      { allowMissingRoot: true },
    );

    expect(db.deleteConvos).toHaveBeenCalledWith(
      'owner-a',
      { conversationId: 'conversation-a' },
      expect.objectContaining({ allowEmpty: true, tenantId: 'tenant-a' }),
    );
    expect(db.deleteToolCalls).toHaveBeenCalledWith('owner-a', 'conversation-a', 'tenant-a');
    expect(deleteConvoSharedLinksWithCleanup).toHaveBeenCalledWith(
      'owner-a',
      'conversation-a',
      'tenant-a',
    );
  });
});
