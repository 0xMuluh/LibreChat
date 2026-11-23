import type { NoteDependencies } from './serviceTypes';
import { isFileSnapshotKillSwitchActive } from '~/shared-links/config';
import { cellRefsFilter, collectCellRefs } from './shareScope';
import { createAgentCellRunner, createNoteAgentLifecycle } from './agent';
import { createExecutionStore } from './executions';
import { serializeArtifact } from './serialization';
import { createExecutionWorker } from './worker';
import { createEventStore } from './events';
import { createEngineRunner } from './runner';
import { createCellStore } from './cells';
import { NoteError } from './errors';

export type NoteService = ReturnType<typeof createCellStore> &
  ReturnType<typeof createExecutionStore> &
  ReturnType<typeof createEventStore> &
  ReturnType<typeof createExecutionWorker> & {
    agentLifecycle: ReturnType<typeof createNoteAgentLifecycle>;
    runAgentCell: ReturnType<typeof createAgentCellRunner>;
    assertConversationAccess(
      conversationId: string,
      userId?: string,
      options?: { readOnly?: boolean },
    ): Promise<{ conversationId: string; userId: string; isShared?: boolean }>;
    resolveUserForConversation(conversationId: string): Promise<string | null>;
    getShareScope(shareId: string): Promise<NoteShareScope | null>;
    serializeArtifact: typeof serializeArtifact;
  };

/** What a share opens: the cells its messages reference, and their files if it includes them. */
export interface NoteShareScope {
  cellIds: Set<string>;
  includeFiles: boolean;
}

export function createNoteService(deps: NoteDependencies): NoteService {
  const cells = createCellStore(deps.models);
  const events = createEventStore(deps.models);
  const runner = createEngineRunner(deps, events.appendEvent);
  const agentLifecycle = createNoteAgentLifecycle(deps.models);
  const worker = createExecutionWorker(deps, events.appendEvent, runner, agentLifecycle.finish);
  const executions = createExecutionStore(
    deps,
    events.appendEvent,
    worker.enqueueExecution,
    worker.resumeExecution,
  );
  async function assertConversationAccess(
    conversationId: string,
    userId?: string,
    options?: { readOnly?: boolean },
  ): Promise<{ conversationId: string; userId: string; isShared?: boolean }> {
    const Conversation = deps.getConversationModel?.();
    if (Conversation && userId) {
      const convo = await Conversation.findOne({ conversationId, user: userId })
        .select('_id user')
        .lean();
      if (convo) {
        return { conversationId, userId: String(convo.user || userId) };
      }
    }

    if (options?.readOnly) {
      const SharedLink = deps.getSharedLinkModel?.();
      if (SharedLink) {
        const now = new Date();
        // Only the share's own id opens it; the note's conversation id stays private.
        const shared = await SharedLink.findOne({
          shareId: conversationId,
          $and: [
            {
              $or: [
                { expiredAt: { $exists: false } },
                { expiredAt: null },
                { expiredAt: { $gt: now } },
              ],
            },
          ],
        })
          .select('conversationId user')
          .lean();
        if (shared?.conversationId) {
          return {
            conversationId: String(shared.conversationId),
            userId: String(shared.user),
            isShared: true,
          };
        }
      }
    }

    if (!Conversation && !deps.getSharedLinkModel?.()) {
      return { conversationId, userId: userId || 'system' };
    }

    throw new NoteError('Conversation not found', 404);
  }

  async function resolveUserForConversation(conversationId: string) {
    const Conversation = deps.getConversationModel();
    if (!Conversation) {
      return null;
    }
    const convo = await Conversation.findOne({ conversationId }).select('user').lean();
    return convo?.user ? String(convo.user) : null;
  }

  /** One read of the share's messages and one of its cells, per request. */
  async function getShareScope(shareId: string): Promise<NoteShareScope | null> {
    const source = await deps.getSharedLinkSource?.(shareId);
    if (!source) {
      return null;
    }
    const filter = source.user ? cellRefsFilter(collectCellRefs(source.messages)) : null;
    const cells = filter
      ? await deps.models.NoteCell.find({
          conversationId: source.conversationId,
          user: source.user,
          ...filter,
        })
          .select('_id')
          .lean()
      : [];
    return {
      cellIds: new Set(cells.map((cell) => String(cell._id))),
      includeFiles: source.snapshotFiles !== false && !isFileSnapshotKillSwitchActive(),
    };
  }

  return {
    createCell: cells.createCell,
    findOrCreateCell: cells.findOrCreateCell,
    listCells: cells.listCells,
    getCell: cells.getCell,
    getCellByBlockKey: cells.getCellByBlockKey,
    appendRevision: cells.appendRevision,
    executeCell: executions.executeCell,
    getExecution: executions.getExecution,
    listExecutions: executions.listExecutions,
    cancelExecution: executions.cancelExecution,
    getArtifactContent: executions.getArtifactContent,
    appendEvent: events.appendEvent,
    listEvents: events.listEvents,
    enqueueExecution: worker.enqueueExecution,
    resumeExecution: worker.resumeExecution,
    trackExecution: worker.trackExecution,
    waitForExecution: worker.waitForExecution,
    sweepExecutions: worker.sweepExecutions,
    agentLifecycle,
    runAgentCell: createAgentCellRunner({
      lifecycle: agentLifecycle,
      resolveUser: resolveUserForConversation,
      bridgeConversationFiles: deps.bridgeConversationFiles,
      engine: runner,
      cancelExecution: executions.cancelExecution,
      track: worker.trackExecution,
    }),
    assertConversationAccess,
    resolveUserForConversation,
    getShareScope,
    serializeArtifact,
  };
}
