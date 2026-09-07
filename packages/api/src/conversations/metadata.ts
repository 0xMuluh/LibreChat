import { logger } from '@librechat/data-schemas';
import type {
  AppConfig,
  ConversationMethods,
  ConversationTagMethods,
} from '@librechat/data-schemas';
import type { FiltersConfig } from 'librechat-data-provider';
import { extractConversationTitleContent } from '../protection/adapters/submissions';
import { ContentFilterError } from '../middleware/contentFilter';
import { inspectContent } from '../protection/runtime';

const MAX_CONVERSATION_TITLE_LENGTH = 1024;

export interface ConversationMetadataDependencies {
  saveConvo: ConversationMethods['saveConvo'];
  updateTagsForConversation: ConversationTagMethods['updateTagsForConversation'];
  reconcileConversationTagCounts: ConversationTagMethods['reconcileConversationTagCounts'];
}

interface ConversationMetadataScope {
  userId: string;
  tenantId?: string;
  conversationId: string;
  interfaceConfig?: AppConfig['interfaceConfig'];
  /** Browser-only retention hint carried by the legacy mutation routes. */
  isTemporary?: boolean;
}

export interface ConversationTitleUpdate extends ConversationMetadataScope {
  title: string;
  filters?: FiltersConfig;
}

export interface ConversationArchiveUpdate extends ConversationMetadataScope {
  isArchived: boolean;
}

export interface ConversationTagsUpdate extends ConversationMetadataScope {
  tags: string[];
}

export interface ConversationMetadataUpdate extends ConversationMetadataScope {
  previousTags: string[];
  title?: string;
  tags?: string[];
  isArchived?: boolean;
  filters?: FiltersConfig;
}

export function normalizeConversationTitle(title: string): string {
  return title.trim().slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export async function updateConversationTitleMetadata(
  deps: Pick<ConversationMetadataDependencies, 'saveConvo'>,
  input: ConversationTitleUpdate,
): ReturnType<ConversationMethods['saveConvo']> {
  const title = normalizeConversationTitle(input.title);
  const finding = inspectContent(extractConversationTitleContent({ title }), {
    filters: input.filters,
  });
  if (finding != null) throw new ContentFilterError(finding);
  return deps.saveConvo(
    {
      userId: input.userId,
      interfaceConfig: input.interfaceConfig,
      isTemporary: input.isTemporary,
    },
    { conversationId: input.conversationId, title },
    {
      context: `conversation title update ${input.conversationId}`,
      noUpsert: true,
      tenantId: input.tenantId ?? null,
    },
  );
}

export async function updateConversationArchiveMetadata(
  deps: Pick<ConversationMetadataDependencies, 'saveConvo'>,
  input: ConversationArchiveUpdate,
): ReturnType<ConversationMethods['saveConvo']> {
  return deps.saveConvo(
    {
      userId: input.userId,
      interfaceConfig: input.interfaceConfig,
      isTemporary: input.isTemporary,
    },
    { conversationId: input.conversationId, isArchived: input.isArchived },
    {
      context: `conversation archive update ${input.conversationId}`,
      preserveUpdatedAt: true,
      noUpsert: true,
      tenantId: input.tenantId ?? null,
    },
  );
}

export async function updateConversationTagsMetadata(
  deps: Pick<ConversationMetadataDependencies, 'updateTagsForConversation'>,
  input: ConversationTagsUpdate,
): ReturnType<ConversationTagMethods['updateTagsForConversation']> {
  return deps.updateTagsForConversation(
    input.userId,
    input.conversationId,
    input.tags,
    input.tenantId ?? null,
  );
}

export async function updateConversationMetadata(
  deps: Pick<ConversationMetadataDependencies, 'saveConvo' | 'reconcileConversationTagCounts'>,
  input: ConversationMetadataUpdate,
): ReturnType<ConversationMethods['saveConvo']> {
  const update: { title?: string; tags?: string[]; isArchived?: boolean } = {};
  if (input.title != null) {
    const title = normalizeConversationTitle(input.title);
    const finding = inspectContent(extractConversationTitleContent({ title }), {
      filters: input.filters,
    });
    if (finding != null) throw new ContentFilterError(finding);
    update.title = title;
  }
  if (input.tags != null) update.tags = input.tags;
  if (input.isArchived != null) update.isArchived = input.isArchived;

  const conversation = await deps.saveConvo(
    { userId: input.userId, interfaceConfig: input.interfaceConfig },
    { conversationId: input.conversationId, ...update },
    {
      context: `conversation metadata update ${input.conversationId}`,
      preserveUpdatedAt: input.title == null && input.tags == null,
      noUpsert: true,
      tenantId: input.tenantId ?? null,
    },
  );
  if (conversation != null && input.tags != null) {
    try {
      await deps.reconcileConversationTagCounts(
        input.userId,
        input.previousTags,
        input.tags,
        input.tenantId ?? null,
      );
    } catch (error) {
      logger.error('[conversationMetadata] Failed to reconcile tag counts', error);
    }
  }
  return conversation;
}
