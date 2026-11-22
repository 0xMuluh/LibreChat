import type { NoteDependencies } from './serviceTypes';
import { createAgentCellRunner, createNoteAgentLifecycle } from './agent';
import { createExecutionStore } from './executions';
import { serializeArtifact } from './serialization';
import { createExecutionWorker } from './worker';
import { createEventStore } from './events';
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
    serializeArtifact: typeof serializeArtifact;
  };

export function createNoteService(deps: NoteDependencies): NoteService {
  const cells = createCellStore(deps.models);
  const events = createEventStore(deps.models);
  const worker = createExecutionWorker(deps, events.appendEvent);
  const executions = createExecutionStore(deps, events.appendEvent, worker.enqueueExecution);
  const agentLifecycle = createNoteAgentLifecycle(deps.models);
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
        const shared = await SharedLink.findOne({
          $or: [{ shareId: conversationId }, { conversationId }],
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

  return {
    createCell: cells.createCell,
    findOrCreateCell: cells.findOrCreateCell,
    listCells: cells.listCells,
    getCell: cells.getCell,
    appendRevision: cells.appendRevision,
    executeCell: executions.executeCell,
    getExecution: executions.getExecution,
    listExecutions: executions.listExecutions,
    cancelExecution: executions.cancelExecution,
    getArtifactContent: executions.getArtifactContent,
    appendEvent: events.appendEvent,
    listEvents: events.listEvents,
    enqueueExecution: worker.enqueueExecution,
    waitForExecution: worker.waitForExecution,
    agentLifecycle,
    runAgentCell: createAgentCellRunner({
      lifecycle: agentLifecycle,
      resolveUser: resolveUserForConversation,
      bridgeConversationFiles: deps.bridgeConversationFiles,
      executeOnEngine: deps.executeOnEngine,
      cancelExecution: executions.cancelExecution,
    }),
    assertConversationAccess,
    resolveUserForConversation,
    serializeArtifact,
  };
}
