import type { ConversationMethods, MessageMethods, ToolCallMethods } from '@librechat/data-schemas';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { logger as Logger } from '@librechat/data-schemas';
import type {
  AgentCheckpointScope,
  deleteAgentCheckpointScopes as deleteCheckpointScopes,
} from '../agents/checkpointer';
import type { GenerationJobManager as GenerationManager } from '../stream/GenerationJobManager';
import type { deleteConvoSharedLinksWithCleanup as deleteLinks } from '../shared-links/service';
import type { SubagentThreadTaskStore } from '../agents/subagentThreads';
import { getOwnedAgentCheckpointScope } from '../agents/checkpointer';

type ConversationFilter = Parameters<ConversationMethods['deleteConvos']>[1];
type DeletionResult = Awaited<ReturnType<ConversationMethods['deleteConvos']>>;
type CancellationPlan = Awaited<
  ReturnType<SubagentThreadTaskStore['planCancellationForConversations']>
>;
export interface ConversationDeletionService {
  canRecoverAgentConversationDeletion: (
    userId: string,
    conversationId: string,
    tenantId?: string,
  ) => Promise<boolean>;
  deleteConversations: (
    userId: string,
    filter: ConversationFilter,
    tenantId?: string,
    checkpointer?: TCheckpointerConfig,
    options?: { allowMissingRoot?: boolean },
  ) => Promise<DeletionResult>;
  withAgentOwnerDeletionFence: (
    userId: string,
    tenantId: string | undefined,
    deletion: () => Promise<DeletionResult>,
    recoverPersistence: () => Promise<DeletionResult>,
    checkpointer?: TCheckpointerConfig,
  ) => Promise<{ result: DeletionResult; recoveryConversationIds: string[] }>;
  deleteOwnerConversationPersistence: (
    userId: string,
    filter: ConversationFilter,
    tenantId: string | undefined,
    checkpointer: TCheckpointerConfig | undefined,
  ) => Promise<DeletionResult>;
}
export interface ConversationDeletionDeps {
  db: Pick<ConversationMethods, 'deleteConvos'> &
    Pick<MessageMethods, 'deleteMessages'> &
    Pick<ToolCallMethods, 'deleteToolCalls'>;
  subagentThreadTaskStore: Pick<
    SubagentThreadTaskStore,
    'planCancellationForConversations' | 'cancelPlan' | 'withOwnerDeletionFence'
  >;
  GenerationJobManager: typeof GenerationManager;
  deleteAgentCheckpointScopes: typeof deleteCheckpointScopes;
  deleteConvoSharedLinksWithCleanup: typeof deleteLinks;
  isStopConfirmed: (result: Awaited<ReturnType<typeof GenerationManager.abortJob>>) => boolean;
  logger: typeof Logger;
}
export function createConversationDeletionService({
  db,
  subagentThreadTaskStore,
  GenerationJobManager,
  deleteAgentCheckpointScopes,
  deleteConvoSharedLinksWithCleanup,
  isStopConfirmed,
  logger,
}: ConversationDeletionDeps): ConversationDeletionService {
  const POST_DELETE_CANCEL_ATTEMPTS = 3;
  const POST_DELETE_CANCEL_BACKOFF_MS = 250;
  const GENERATION_PERSISTENCE_DRAIN_TIMEOUT_MS = 45_000;
  const GENERATION_PERSISTENCE_DRAIN_POLL_MS = 100;
  const GENERATION_LOOKUP_ATTEMPTS = 3;

  function addCheckpointScopes(
    target: Map<string, AgentCheckpointScope>,
    scopes: readonly AgentCheckpointScope[],
  ): void {
    for (const scope of scopes) {
      target.set(`${scope.threadId}\0${scope.checkpointNamespace}`, scope);
    }
  }

  async function readGenerationForDeletion(conversationId: string) {
    let lastError;
    for (let attempt = 1; attempt <= GENERATION_LOOKUP_ATTEMPTS; attempt += 1) {
      try {
        return await GenerationJobManager.getJob(conversationId);
      } catch (error) {
        lastError = error;
        if (attempt < GENERATION_LOOKUP_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    }
    throw lastError;
  }

  /** Replays a cancellation plan after deletion, retrying a transiently unreachable
   * owner rather than losing the only pass that can stop a late-admitted child. */
  async function retryPostDeleteCancellation(
    cancellationPlan: CancellationPlan,
    deletedConversationIds: string[],
  ) {
    for (let attempt = 1; attempt <= POST_DELETE_CANCEL_ATTEMPTS; attempt += 1) {
      try {
        await subagentThreadTaskStore.cancelPlan(cancellationPlan, deletedConversationIds);
        return;
      } catch (error) {
        if (attempt === POST_DELETE_CANCEL_ATTEMPTS) {
          logger.warn('Post-delete subagent cancellation failed', error);
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, POST_DELETE_CANCEL_BACKOFF_MS * attempt),
        );
      }
    }
  }

  /** Confirms every exact generation is stopped before its conversation wave is removed. */
  async function confirmAgentGenerationsDrained(
    userId: string,
    conversationIds: string[],
    leaseTaskIds: string[] = [],
    tenantId?: string,
    ownerWide = false,
  ) {
    const drainErrors = [];
    const checkpointScopes = new Map<string, AgentCheckpointScope>();
    const deletionTargets = new Set(conversationIds);
    let conversationRunIds;
    try {
      const retainedScopes = await GenerationJobManager.getRetainedCheckpointScopesForUser(
        userId,
        tenantId,
      );
      addCheckpointScopes(
        checkpointScopes,
        retainedScopes.filter((scope) => ownerWide || deletionTargets.has(scope.threadId)),
      );
      conversationRunIds = ownerWide
        ? await GenerationJobManager.getCleanupBlockingJobIdsForUser(userId, tenantId)
        : await GenerationJobManager.getCleanupBlockingJobIdsForConversations(
            userId,
            conversationIds,
            tenantId,
          );
    } catch (error) {
      logger.warn('Conversation generation index lookup failed', error);
      throw new Error('Conversation generations could not be confirmed drained.');
    }
    const generationIds = [
      ...new Set([...conversationIds, ...leaseTaskIds, ...conversationRunIds]),
    ];
    await Promise.all(
      generationIds.map(async (conversationId) => {
        let job;
        try {
          job = await readGenerationForDeletion(conversationId);
        } catch (error) {
          logger.warn('Deleted child generation lookup failed', error);
          drainErrors.push(error);
          return;
        }
        if (job == null || job.metadata.userId !== userId) {
          return;
        }
        const jobTenantId = job.metadata.tenantId;
        if (jobTenantId != null && jobTenantId !== tenantId) return;
        const checkpointScope = getOwnedAgentCheckpointScope(job, userId, tenantId);
        if (
          checkpointScope != null &&
          (ownerWide || deletionTargets.has(checkpointScope.threadId))
        ) {
          checkpointScopes.set(
            `${checkpointScope.threadId}\0${checkpointScope.checkpointNamespace}`,
            checkpointScope,
          );
        }
        const needsDrain =
          job.status === 'running' ||
          job.status === 'requires_action' ||
          job.metadata?.providerDrained === false ||
          job.metadata?.terminalPersistencePending === true;
        if (!needsDrain) return;
        try {
          const abortResult = await GenerationJobManager.abortJob(conversationId, {
            expectedCreatedAt: job.createdAt,
            awaitProviderDrain: true,
          });
          if (!isStopConfirmed(abortResult)) {
            throw new Error(
              `Could not confirm generation stop for ${conversationId}: ${abortResult?.failureReason ?? 'unknown'}`,
            );
          }
          const deadline = Date.now() + GENERATION_PERSISTENCE_DRAIN_TIMEOUT_MS;
          while (true) {
            const current = await GenerationJobManager.getJob(conversationId);
            if (
              current == null ||
              current.createdAt !== job.createdAt ||
              current.metadata?.terminalPersistencePending !== true
            ) {
              break;
            }
            if (Date.now() >= deadline) {
              throw new Error(`Timed out waiting for generation persistence: ${conversationId}`);
            }
            await new Promise((resolve) =>
              setTimeout(resolve, GENERATION_PERSISTENCE_DRAIN_POLL_MS),
            );
          }
        } catch (error) {
          logger.warn('Deleted child generation drain failed', error);
          drainErrors.push(error);
        }
      }),
    );
    if (drainErrors.length > 0) {
      throw new Error('One or more deleted child generations could not be confirmed drained.');
    }
    return [...checkpointScopes.values()];
  }

  async function deleteAndAcknowledgeCheckpointScopes(
    userId: string,
    tenantId: string | undefined,
    scopes: AgentCheckpointScope[],
    checkpointer?: TCheckpointerConfig,
  ): Promise<void> {
    if (scopes.length === 0) return;
    await deleteAgentCheckpointScopes(scopes, checkpointer);
    await GenerationJobManager.acknowledgeCheckpointScopesForUser(userId, tenantId, scopes);
  }

  /** Repeats generation discovery after the conversation wave is gone, then always
   * removes remnants for that immutable deletion set. A remote run may settle and
   * leave the cleanup index between persisting and this lookup; absence from the
   * index is therefore not evidence that the second persistence sweep is unnecessary. */
  async function drainDeletedAgentGenerations(
    userId: string,
    conversationIds: string[],
    leaseTaskIds: string[] = [],
    tenantId?: string,
  ) {
    const checkpointScopes = await confirmAgentGenerationsDrained(
      userId,
      conversationIds,
      leaseTaskIds,
      tenantId,
    );
    await db.deleteConvos(
      userId,
      { conversationId: { $in: conversationIds } },
      {
        allowEmpty: true,
        tenantId: tenantId ?? null,
      },
    );
    await db.deleteMessages({
      user: userId,
      conversationId: { $in: conversationIds },
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
    });
    return checkpointScopes;
  }

  /** Orders every owner-scoped agent execution against a delete-all persistence
   * snapshot. The recovery callback repeats the non-subagent drain if the durable
   * fence ever lapses and must be reacquired after deletion has started. */
  async function withAgentOwnerDeletionFence(
    userId: string,
    tenantId: string | undefined,
    deletion: () => Promise<DeletionResult>,
    recoverPersistence: () => Promise<DeletionResult>,
    checkpointer?: TCheckpointerConfig,
  ) {
    const checkpointScopes = new Map<string, AgentCheckpointScope>();
    const drainRemoteRuns = async () => {
      addCheckpointScopes(
        checkpointScopes,
        await confirmAgentGenerationsDrained(userId, [], [], tenantId, true),
      );
    };
    let recoveryConversationIds: string[] = [];
    const result = await subagentThreadTaskStore.withOwnerDeletionFence(
      userId,
      tenantId,
      async () => {
        await drainRemoteRuns();
        return deletion();
      },
      async () => {
        await drainRemoteRuns();
        /** Runs only after the fence was restored. No new provider may enter while
         * persistence created during the gap is removed idempotently. */
        const recovery = await recoverPersistence();
        recoveryConversationIds = recovery.conversationIds ?? [];
      },
    );
    if (checkpointScopes.size > 0) {
      await deleteAndAcknowledgeCheckpointScopes(
        userId,
        tenantId,
        [...checkpointScopes.values()],
        checkpointer,
      );
    }
    return { result, recoveryConversationIds };
  }

  async function deleteOwnerConversationPersistence(
    userId: string,
    filter: ConversationFilter,
    tenantId: string | undefined,
    checkpointer: TCheckpointerConfig | undefined,
  ) {
    const checkpointScopes = new Map<string, AgentCheckpointScope>();
    const result = await db.deleteConvos(userId, filter, {
      allowEmpty: true,
      tenantId: tenantId ?? null,
      beforeDelete: async (conversationIds) => {
        addCheckpointScopes(
          checkpointScopes,
          await confirmAgentGenerationsDrained(userId, conversationIds, [], tenantId),
        );
      },
    });
    /** Consume the deletion receipt before the fallible message sweep. A retry after
     * conversations are gone cannot reconstruct these checkpoint identities. */
    if (checkpointScopes.size > 0) {
      await deleteAndAcknowledgeCheckpointScopes(
        userId,
        tenantId,
        [...checkpointScopes.values()],
        checkpointer,
      );
    }
    /** Always runs, including an empty conversation retry, so an interrupted writer
     * that persisted messages first cannot make its cleanup permanently unreachable. */
    await db.deleteMessages({
      user: userId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
    });
    return result;
  }

  async function deleteConversations(
    userId: string,
    filter: ConversationFilter,
    tenantId?: string,
    checkpointer?: TCheckpointerConfig,
    options?: { allowMissingRoot?: boolean },
  ) {
    let cancellationPlan;
    let dbResponse;
    let recoveryConversationIds: string[] = [];
    const checkpointScopes = new Map<string, AgentCheckpointScope>();
    if (filter.conversationId) {
      /** Resolve the targets while the conversations still exist: the second pass
       * runs after their rows are gone and can only reach registered owners. */
      cancellationPlan = await subagentThreadTaskStore.planCancellationForConversations(
        userId,
        [filter.conversationId],
        tenantId,
      );
      await subagentThreadTaskStore.cancelPlan(cancellationPlan);
      dbResponse = await db.deleteConvos(userId, filter, {
        tenantId: tenantId ?? null,
        allowEmpty: options?.allowMissingRoot === true,
        beforeDelete: async (conversationIds) => {
          addCheckpointScopes(
            checkpointScopes,
            await confirmAgentGenerationsDrained(userId, conversationIds, [], tenantId),
          );
        },
      });
    } else {
      /** An empty filter deletes every conversation this owner has, so it runs behind
       * the same admission fence as `DELETE /all` rather than a bare drain. */
      const fencedDeletion = await withAgentOwnerDeletionFence(
        userId,
        tenantId,
        () => deleteOwnerConversationPersistence(userId, filter, tenantId, checkpointer),
        () => deleteOwnerConversationPersistence(userId, filter, tenantId, checkpointer),
        checkpointer,
      );
      dbResponse = fencedDeletion.result;
      recoveryConversationIds = fencedDeletion.recoveryConversationIds;
    }
    const deletedConversationIds = [
      ...new Set([
        ...(dbResponse.conversationIds ?? (filter.conversationId ? [filter.conversationId] : [])),
        ...(options?.allowMissingRoot === true && typeof filter.conversationId === 'string'
          ? [filter.conversationId]
          : []),
        ...recoveryConversationIds,
      ]),
    ];
    /** Root deletion closes new child admission. Replay the plan to catch a task
     * admitted after the first pass but before that fence, extended with the cascade
     * this deletion reported. */
    if (cancellationPlan != null && deletedConversationIds.length > 0) {
      /** The conversations are gone, so this pass is the only thing that can still
       * stop a child admitted after the first one. It cannot fail the request — the
       * deletion already committed — so it retries briefly before giving up. */
      await retryPostDeleteCancellation(cancellationPlan, deletedConversationIds);
      addCheckpointScopes(
        checkpointScopes,
        await drainDeletedAgentGenerations(
          userId,
          deletedConversationIds,
          cancellationPlan.leases
            .filter(
              (lease) =>
                deletedConversationIds.includes(lease.parentConversationId) ||
                deletedConversationIds.includes(lease.conversationId),
            )
            .map((lease) => lease.taskId),
          tenantId,
        ),
      );
    } else if (deletedConversationIds.length > 0) {
      /** Owner-wide deletion drains lease-backed tasks before the cascade, but a
       * requires_action event actor has intentionally released its lease. Its durable
       * generation is still addressable by the deleted conversation id and must be
       * terminalized before its checkpoint is pruned. */
      addCheckpointScopes(
        checkpointScopes,
        await drainDeletedAgentGenerations(userId, deletedConversationIds, [], tenantId),
      );
    }
    /** Legacy generations have no owner-bound namespace and remain for TTL cleanup. */
    if (checkpointScopes.size > 0) {
      await deleteAndAcknowledgeCheckpointScopes(
        userId,
        tenantId,
        [...checkpointScopes.values()],
        checkpointer,
      );
    }
    if (filter.conversationId) {
      await Promise.all(
        deletedConversationIds.map((id) => db.deleteToolCalls(userId, id, tenantId ?? null)),
      );
      await Promise.all(
        deletedConversationIds.map((id) =>
          deleteConvoSharedLinksWithCleanup(userId, id, tenantId ?? null),
        ),
      );
    }
    return dbResponse;
  }

  async function canRecoverAgentConversationDeletion(
    userId: string,
    conversationId: string,
    tenantId?: string,
  ): Promise<boolean> {
    const retainedScopes = await GenerationJobManager.getRetainedCheckpointScopesForUser(
      userId,
      tenantId,
    );
    if (retainedScopes.some((scope) => scope.threadId === conversationId)) {
      return true;
    }

    const cancellationPlan = await subagentThreadTaskStore.planCancellationForConversations(
      userId,
      [conversationId],
      tenantId,
    );
    if (
      cancellationPlan.leases.some(
        (lease) =>
          lease.conversationId === conversationId || lease.parentConversationId === conversationId,
      )
    ) {
      return true;
    }

    const generationIds = await GenerationJobManager.getCleanupBlockingJobIdsForConversations(
      userId,
      [conversationId],
      tenantId,
    );
    for (const generationId of generationIds) {
      const job = await readGenerationForDeletion(generationId);
      if (
        job?.metadata.userId === userId &&
        job.metadata.conversationId === conversationId &&
        (job.metadata.tenantId == null || job.metadata.tenantId === tenantId)
      ) {
        return true;
      }
    }
    return false;
  }

  return {
    canRecoverAgentConversationDeletion,
    deleteConversations,
    withAgentOwnerDeletionFence,
    deleteOwnerConversationPersistence,
  };
}
