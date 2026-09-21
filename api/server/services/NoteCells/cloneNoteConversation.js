const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const models = require('./models');
const { getProjectsDir } = require('./noteDataBridge');

async function cloneProjectDirectory(sourceConversationId, targetConversationId) {
  try {
    const projectsDir = getProjectsDir();
    const srcDir = path.join(projectsDir, String(sourceConversationId));
    const destDir = path.join(projectsDir, String(targetConversationId));

    if (fs.existsSync(srcDir)) {
      await fs.promises.mkdir(destDir, { recursive: true });
      await fs.promises.cp(srcDir, destDir, { recursive: true });
      logger.info(
        `[cloneNoteConversation] Copied workspace files from ${srcDir} -> ${destDir}`,
      );
    }
  } catch (err) {
    logger.warn('[cloneNoteConversation] Workspace directory copy skipped or failed:', err);
  }
}

async function updateClonedMessageNoteReferences({
  targetConversationId,
  cellIdMap,
  execIdMap,
}) {
  if (cellIdMap.size === 0 && execIdMap.size === 0) {
    return;
  }
  const Message = mongoose.models.Message;
  if (!Message) {
    return;
  }

  const messages = await Message.find({ conversationId: targetConversationId }).lean();
  for (const msg of messages) {
    let updated = false;
    let text = msg.text || '';

    text = text.replace(
      /<!--\s*noteCell\s+cellId=([^\s]+)\s+executionId=([^\s]+)(.*?-->)/g,
      (fullMatch, oldCellId, oldExecId, rest) => {
        const newCellId = cellIdMap.get(oldCellId) ? String(cellIdMap.get(oldCellId)) : oldCellId;
        const newExecId = execIdMap.get(oldExecId) ? String(execIdMap.get(oldExecId)) : oldExecId;
        if (newCellId !== oldCellId || newExecId !== oldExecId) {
          updated = true;
          return `<!-- noteCell cellId=${newCellId} executionId=${newExecId}${rest}`;
        }
        return fullMatch;
      },
    );

    let content = msg.content;
    if (Array.isArray(content)) {
      content = JSON.parse(JSON.stringify(content));
      for (const part of content) {
        if (part?.text?.value && typeof part.text.value === 'string') {
          part.text.value = part.text.value.replace(
            /<!--\s*noteCell\s+cellId=([^\s]+)\s+executionId=([^\s]+)(.*?-->)/g,
            (fullMatch, oldCellId, oldExecId, rest) => {
              const newCellId = cellIdMap.get(oldCellId)
                ? String(cellIdMap.get(oldCellId))
                : oldCellId;
              const newExecId = execIdMap.get(oldExecId)
                ? String(execIdMap.get(oldExecId))
                : oldExecId;
              if (newCellId !== oldCellId || newExecId !== oldExecId) {
                updated = true;
                return `<!-- noteCell cellId=${newCellId} executionId=${newExecId}${rest}`;
              }
              return fullMatch;
            },
          );
        }
        if (part?.tool_call?.output && typeof part.tool_call.output === 'string') {
          part.tool_call.output = part.tool_call.output.replace(
            /<!--\s*noteCell\s+cellId=([^\s]+)\s+executionId=([^\s]+)(.*?-->)/g,
            (fullMatch, oldCellId, oldExecId, rest) => {
              const newCellId = cellIdMap.get(oldCellId)
                ? String(cellIdMap.get(oldCellId))
                : oldCellId;
              const newExecId = execIdMap.get(oldExecId)
                ? String(execIdMap.get(oldExecId))
                : oldExecId;
              if (newCellId !== oldCellId || newExecId !== oldExecId) {
                updated = true;
                return `<!-- noteCell cellId=${newCellId} executionId=${newExecId}${rest}`;
              }
              return fullMatch;
            },
          );
        }
      }
    }

    if (updated) {
      await Message.updateOne(
        { _id: msg._id },
        { $set: { text, ...(content ? { content } : {}) } },
      );
    }
  }
}

/**
 * Clones NoteCells, revisions, executions, artifacts, events, and project workspace directory
 * from a source conversation to a target conversation.
 */
async function cloneNoteConversation({
  sourceConversationId,
  targetConversationId,
  targetUserId,
  messageIdMap = new Map(),
}) {
  if (!sourceConversationId || !targetConversationId || !targetUserId) {
    return;
  }

  if (mongoose.connection.readyState !== 1) {
    return;
  }

  try {
    const cells = await models.NoteCell.find({ conversationId: sourceConversationId }).lean();
    if (!cells || cells.length === 0) {
      await cloneProjectDirectory(sourceConversationId, targetConversationId);
      return;
    }

    const cellIdMap = new Map();
    const revIdMap = new Map();
    const execIdMap = new Map();

    for (const cell of cells) {
      const oldCellIdStr = String(cell._id);
      const newCellId = new mongoose.Types.ObjectId();
      cellIdMap.set(oldCellIdStr, newCellId);

      // 1. Clone revisions for this cell
      const revisions = await models.NoteCellRevision.find({ cellId: cell._id }).lean();
      for (const rev of revisions) {
        const oldRevIdStr = String(rev._id);
        const newRevId = new mongoose.Types.ObjectId();
        revIdMap.set(oldRevIdStr, newRevId);

        await models.NoteCellRevision.create({
          _id: newRevId,
          cellId: newCellId,
          conversationId: targetConversationId,
          user: targetUserId,
          revision: rev.revision,
          language: rev.language || 'r',
          content: rev.content ?? '',
        });
      }

      // 2. Clone executions for this cell
      const executions = await models.NoteCellExecution.find({ cellId: cell._id }).lean();
      for (const exec of executions) {
        const oldExecIdStr = String(exec._id);
        const newExecId = new mongoose.Types.ObjectId();
        execIdMap.set(oldExecIdStr, newExecId);

        const newRevId = exec.revisionId ? revIdMap.get(String(exec.revisionId)) : null;

        await models.NoteCellExecution.create({
          _id: newExecId,
          cellId: newCellId,
          revisionId: newRevId || new mongoose.Types.ObjectId(),
          conversationId: targetConversationId,
          user: targetUserId,
          attempt: exec.attempt || 1,
          status: exec.status || 'completed',
          timeoutSeconds: exec.timeoutSeconds || 180,
          cancelRequested: false,
          error: exec.error || null,
          stdout: exec.stdout || null,
          markdown: exec.markdown || null,
          engineRunDir: exec.engineRunDir || null,
          engineCellId: exec.engineCellId || null,
          startedAt: exec.startedAt || null,
          finishedAt: exec.finishedAt || null,
        });

        // 3. Clone artifacts for this execution
        const artifacts = await models.NoteExecutionArtifact.find({
          executionId: exec._id,
        }).lean();
        for (const art of artifacts) {
          await models.NoteExecutionArtifact.create({
            _id: new mongoose.Types.ObjectId(),
            executionId: newExecId,
            conversationId: targetConversationId,
            user: targetUserId,
            artifactType: art.artifactType,
            relativePath: art.relativePath,
            mimeType: art.mimeType || 'application/octet-stream',
            byteSize: art.byteSize || 0,
            previewMarkdown: art.previewMarkdown || null,
            rows: art.rows ?? null,
            cols: art.cols ?? null,
          });
        }

        // 4. Clone events for this execution
        const events = await models.NoteExecutionEvent.find({ executionId: exec._id }).lean();
        for (const ev of events) {
          await models.NoteExecutionEvent.create({
            _id: new mongoose.Types.ObjectId(),
            executionId: newExecId,
            conversationId: targetConversationId,
            sequence: ev.sequence,
            eventType: ev.eventType,
            status: ev.status || null,
            payload: ev.payload || null,
          });
        }
      }

      // 5. Clone NoteCell document
      const mappedMessageId =
        (cell.messageId && messageIdMap.get(cell.messageId)) || cell.messageId;
      const latestRevId = cell.latestRevisionId
        ? revIdMap.get(String(cell.latestRevisionId))
        : null;
      const latestExecId = cell.latestExecutionId
        ? execIdMap.get(String(cell.latestExecutionId))
        : null;

      await models.NoteCell.create({
        _id: newCellId,
        conversationId: targetConversationId,
        user: targetUserId,
        messageId: mappedMessageId || null,
        blockKey: cell.blockKey || null,
        position: cell.position || 0,
        status: cell.status || 'active',
        latestRevisionId: latestRevId,
        latestExecutionId: latestExecId,
      });
    }

    // 6. Clone project directory on disk
    await cloneProjectDirectory(sourceConversationId, targetConversationId);

    // 7. Update cellId / executionId metadata in cloned messages
    await updateClonedMessageNoteReferences({
      targetConversationId,
      cellIdMap,
      execIdMap,
    });

    logger.info(
      `[cloneNoteConversation] Cloned ${cells.length} NoteCells from ${sourceConversationId} to ${targetConversationId} for user ${targetUserId}`,
    );
  } catch (err) {
    logger.error('[cloneNoteConversation] Error cloning note conversation:', err);
  }
}

module.exports = {
  cloneNoteConversation,
  cloneProjectDirectory,
};
