import mongoose from 'mongoose';
import type { ResolvedCheckpointerConfig } from '../checkpointer';

interface ConversationOwner {
  conversationId: string;
  user: string;
  tenantId?: string;
}

interface LegacyCheckpoint {
  _id: mongoose.mongo.ObjectId;
  thread_id: string;
}

/** Legacy storage has no owner field: retain conversation evidence until cleanup completes. */
export async function deleteLegacyCheckpoints(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  config: ResolvedCheckpointerConfig,
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Checkpoint database is unavailable');
  const conversations = db.collection<ConversationOwner>(
    mongoose.models.Conversation?.collection.name ?? 'conversations',
  );
  const owner = {
    user: userId,
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
  const batchSize = 256;

  async function removeBatch(ids: string[]) {
    const conflicts = new Set(
      (await conversations.distinct('conversationId', {
        conversationId: { $in: ids },
        $nor: [owner],
      })) as string[],
    );
    for (const name of [config.checkpointCollectionName, config.checkpointWritesCollectionName]) {
      const collection = db!.collection<LegacyCheckpoint>(name);
      const rows = collection.find(
        { thread_id: { $in: ids }, checkpoint_ns: { $not: /^lcg:v2:/ } },
        { projection: { _id: 1, thread_id: 1 } },
      );
      let captured: mongoose.mongo.ObjectId[] = [];
      try {
        for await (const row of rows) {
          if (conflicts.has(row.thread_id)) {
            throw new Error('Legacy checkpoint ownership is ambiguous; migration is required');
          }
          captured.push(row._id);
          if (captured.length === batchSize) {
            await collection.deleteMany({ _id: { $in: captured } });
            captured = [];
          }
        }
        if (captured.length > 0) await collection.deleteMany({ _id: { $in: captured } });
      } finally {
        await rows.close();
      }
    }
  }

  for (let offset = 0; offset < (conversationIds?.length ?? 1); offset += batchSize) {
    const requested = conversationIds?.slice(offset, offset + batchSize);
    const cursor = conversations.find(
      { ...owner, ...(requested && { conversationId: { $in: requested } }) },
      { projection: { conversationId: 1 } },
    );
    let ids: string[] = [];
    try {
      for await (const conversation of cursor) {
        ids.push(conversation.conversationId);
        if (ids.length === batchSize) {
          await removeBatch(ids);
          ids = [];
        }
      }
      if (ids.length > 0) await removeBatch(ids);
    } finally {
      await cursor.close();
    }
  }
}
