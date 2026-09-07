import { logger } from '@librechat/data-schemas';
import { updateConversationMetadata } from './metadata';

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

describe('updateConversationMetadata', () => {
  it('commits requested fields in one conversation write and then reconciles tag counts', async () => {
    const conversation = { conversationId: 'conversation-a', tags: ['next'] };
    const saveConvo = jest.fn().mockResolvedValue(conversation);
    const reconcileConversationTagCounts = jest.fn().mockResolvedValue(undefined);

    await expect(
      updateConversationMetadata(
        { saveConvo, reconcileConversationTagCounts },
        {
          userId: 'owner-a',
          tenantId: 'tenant-a',
          conversationId: 'conversation-a',
          previousTags: ['previous'],
          title: ' New title ',
          tags: ['next'],
          isArchived: true,
        },
      ),
    ).resolves.toBe(conversation);

    expect(saveConvo).toHaveBeenCalledTimes(1);
    expect(saveConvo).toHaveBeenCalledWith(
      { userId: 'owner-a', interfaceConfig: undefined },
      {
        conversationId: 'conversation-a',
        title: 'New title',
        tags: ['next'],
        isArchived: true,
      },
      expect.objectContaining({ noUpsert: true, tenantId: 'tenant-a' }),
    );
    expect(reconcileConversationTagCounts).toHaveBeenCalledWith(
      'owner-a',
      ['previous'],
      ['next'],
      'tenant-a',
    );
  });

  it('does not turn a derived tag-count failure into an ambiguous PATCH failure', async () => {
    const conversation = { conversationId: 'conversation-a', tags: ['next'] };
    const error = new Error('count update failed');
    const saveConvo = jest.fn().mockResolvedValue(conversation);
    const reconcileConversationTagCounts = jest.fn().mockRejectedValue(error);

    await expect(
      updateConversationMetadata(
        { saveConvo, reconcileConversationTagCounts },
        {
          userId: 'owner-a',
          conversationId: 'conversation-a',
          previousTags: [],
          tags: ['next'],
        },
      ),
    ).resolves.toBe(conversation);
    expect(logger.error).toHaveBeenCalledWith(
      '[conversationMetadata] Failed to reconcile tag counts',
      error,
    );
  });

  it('does not apply tag-count side effects when the conversation write fails', async () => {
    const error = new Error('write failed');
    const saveConvo = jest.fn().mockRejectedValue(error);
    const reconcileConversationTagCounts = jest.fn();

    await expect(
      updateConversationMetadata(
        { saveConvo, reconcileConversationTagCounts },
        {
          userId: 'owner-a',
          conversationId: 'conversation-a',
          previousTags: ['previous'],
          tags: ['next'],
        },
      ),
    ).rejects.toBe(error);
    expect(reconcileConversationTagCounts).not.toHaveBeenCalled();
  });
});
