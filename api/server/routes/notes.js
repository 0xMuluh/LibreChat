const express = require('express');
const { pipeline } = require('stream');
const { logger } = require('@librechat/data-schemas');
const optionalJwtAuth = require('~/server/middleware/optionalJwtAuth');
const canAccessSharedNote = require('~/server/middleware/canAccessSharedNote');
const noteCells = require('~/server/services/NoteCells/service');

const router = express.Router({ mergeParams: true });

const getUserId = (req) => req.user?.id ?? req.user?._id?.toString() ?? '';

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function sendError(res, err) {
  const status = err.status || 500;
  return res.status(status).json({ error: err.message || 'Internal error' });
}

function withArtifactUrls(conversationId, cellId, executionId, payload) {
  if (!payload) {
    return payload;
  }
  const base = `/api/notes/${encodeURIComponent(conversationId)}/cells/${encodeURIComponent(cellId)}/executions/${encodeURIComponent(executionId)}/artifacts`;
  if (Array.isArray(payload.artifacts)) {
    payload.artifacts = payload.artifacts.map((a) => ({
      ...a,
      contentUrl: `${base}/${encodeURIComponent(a.id)}/content`,
    }));
  }
  return payload;
}

/**
 * Names the download. A file the run wrote is saved, never shown in the page; the plain
 * `filename` keeps ASCII only and `filename*` carries the real name (RFC 5987).
 */
function contentDisposition(artifact) {
  const name = (artifact.relativePath || 'artifact').split('/').pop() || 'artifact';
  const type = artifact.artifactType === 'file' ? 'attachment' : 'inline';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A run's figures and tables reach a share's viewers only when the share includes files. */
function executionForViewer(req, execution) {
  if (!execution || !req.noteShare || req.noteShare.includeFiles) {
    return execution;
  }
  return { ...execution, artifacts: [], filesTruncated: false };
}

/** A shared view reads cells by shareId; the share keeps the note's own conversation id hidden. */
function forViewer(req, cell) {
  if (!req.noteIsShared) {
    return cell;
  }
  const { conversationId: _conversationId, ...visible } = cell;
  if (visible.latestExecution) {
    visible.latestExecution = executionForViewer(req, visible.latestExecution);
  }
  return visible;
}

/** True when the request comes through a share that does not show this cell. */
function hiddenByShare(req, cellId) {
  return req.noteShare != null && !req.noteShare.cellIds.has(String(cellId));
}

/** A share shows only the cells its messages reference, up to its target message. */
async function loadShareScope(req, res, next) {
  const scope = await noteCells.getShareScope(req.params.conversationId);
  if (!scope) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  req.noteShare = scope;
  return next();
}

const authed = express.Router({ mergeParams: true });
authed.use(optionalJwtAuth);

authed.use(
  asyncHandler(async (req, res, next) => {
    const userId = getUserId(req);
    const conversationId = req.params.conversationId;
    const isReadOnly = req.method === 'GET' || req.method === 'HEAD';

    if (!isReadOnly && !userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let access;
    try {
      access = await noteCells.assertConversationAccess(conversationId, userId, {
        readOnly: isReadOnly,
      });
    } catch (err) {
      if (
        err.status === 404 &&
        req.method === 'POST' &&
        (req.path === '/cells' || req.path.endsWith('/cells')) &&
        userId
      ) {
        req.noteUserId = userId;
        req.noteConversationId = conversationId;
        return next();
      }
      return sendError(res, err);
    }
    req.noteUserId = access.userId;
    req.noteConversationId = access.conversationId;
    req.noteIsShared = access.isShared === true;
    if (!req.noteIsShared) {
      return next();
    }
    // A share opens to whom the share page opens (public, signed in, or named people).
    return canAccessSharedNote(req, res, () => loadShareScope(req, res, next).catch(next));
  }),
);

authed.param('cellId', (req, res, next, cellId) => {
  if (hiddenByShare(req, cellId)) {
    return res.status(404).json({ error: 'Cell not found' });
  }
  return next();
});

authed.get(
  '/cells',
  asyncHandler(async (req, res) => {
    const { blockKey } = req.query;
    if (blockKey != null) {
      if (typeof blockKey !== 'string' || !blockKey) {
        return res.status(400).json({ error: 'blockKey must be a string' });
      }
      const cell = await noteCells.getCellByBlockKey(
        req.noteConversationId,
        req.noteUserId,
        blockKey,
      );
      if (hiddenByShare(req, cell.id)) {
        return res.status(404).json({ error: 'Cell not found' });
      }
      if (cell.latestExecution) {
        withArtifactUrls(
          req.params.conversationId,
          cell.id,
          cell.latestExecution.id,
          cell.latestExecution,
        );
      }
      return res.json(forViewer(req, cell));
    }
    const cells = await noteCells.listCells(
      req.noteConversationId,
      req.noteUserId,
      req.noteShare?.cellIds,
    );
    for (const cell of cells) {
      if (cell.latestExecution) {
        withArtifactUrls(
          req.params.conversationId,
          cell.id,
          cell.latestExecution.id,
          cell.latestExecution,
        );
      }
    }
    res.json({ cells: cells.map((cell) => forViewer(req, cell)) });
  }),
);

authed.post(
  '/cells',
  asyncHandler(async (req, res) => {
    const { content, messageId, blockKey, cellId } = req.body || {};
    const cell = await noteCells.findOrCreateCell({
      conversationId: req.noteConversationId,
      userId: req.noteUserId,
      cellId,
      messageId: messageId || null,
      blockKey: blockKey || null,
      content: content || '',
    });
    res.status(201).json(cell);
  }),
);

authed.get(
  '/cells/:cellId',
  asyncHandler(async (req, res) => {
    const cell = await noteCells.getCell(req.noteConversationId, req.noteUserId, req.params.cellId);
    if (cell.latestExecution) {
      withArtifactUrls(
        req.params.conversationId,
        cell.id,
        cell.latestExecution.id,
        cell.latestExecution,
      );
    }
    res.json(forViewer(req, cell));
  }),
);

authed.post(
  '/cells/:cellId/revisions',
  asyncHandler(async (req, res) => {
    const revision = await noteCells.appendRevision({
      conversationId: req.noteConversationId,
      userId: req.noteUserId,
      cellId: req.params.cellId,
      content: req.body?.content ?? '',
      language: req.body?.language || 'r',
    });
    res.status(201).json(revision);
  }),
);

authed.post(
  '/cells/:cellId/execute',
  asyncHandler(async (req, res) => {
    const execution = await noteCells.executeCell({
      conversationId: req.noteConversationId,
      userId: req.noteUserId,
      cellId: req.params.cellId,
      revisionId: req.body?.revisionId || null,
      timeoutSeconds: Number(req.body?.timeout_seconds) || 600,
    });
    res.status(202).json(execution);
  }),
);

authed.get(
  '/cells/:cellId/executions',
  asyncHandler(async (req, res) => {
    const executions = await noteCells.listExecutions(
      req.noteConversationId,
      req.noteUserId,
      req.params.cellId,
    );
    res.json({ executions });
  }),
);

authed.post(
  '/cells/:cellId/executions/:executionId/cancel',
  asyncHandler(async (req, res) => {
    const execution = await noteCells.cancelExecution(
      req.noteConversationId,
      req.noteUserId,
      req.params.cellId,
      req.params.executionId,
    );
    res.json(execution);
  }),
);

authed.get(
  '/cells/:cellId/executions/:executionId',
  asyncHandler(async (req, res) => {
    const execution = await noteCells.getExecution(
      req.noteConversationId,
      req.noteUserId,
      req.params.cellId,
      req.params.executionId,
    );
    withArtifactUrls(
      req.params.conversationId,
      req.params.cellId,
      req.params.executionId,
      execution,
    );
    res.json(executionForViewer(req, execution));
  }),
);

authed.get(
  '/cells/:cellId/executions/:executionId/events',
  asyncHandler(async (req, res) => {
    const after = Number(req.query.after_sequence) || 0;
    const events = await noteCells.listEvents(
      req.noteConversationId,
      req.noteUserId,
      req.params.cellId,
      req.params.executionId,
      after,
    );
    res.json({ events });
  }),
);

authed.get(
  '/cells/:cellId/executions/:executionId/artifacts/:artifactId/content',
  asyncHandler(async (req, res) => {
    if (req.noteShare && !req.noteShare.includeFiles) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    const content = await noteCells.getArtifactContent(
      req.noteConversationId,
      req.noteUserId,
      req.params.cellId,
      req.params.executionId,
      req.params.artifactId,
    );
    res.setHeader('Content-Type', content.contentType);
    res.setHeader('Content-Disposition', contentDisposition(content.artifact));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!content.stream) {
      return res.send(content.buffer);
    }
    if (content.contentLength) {
      res.setHeader('Content-Length', content.contentLength);
    }
    // A failure mid-file can only cut the download short; the headers are already sent.
    pipeline(content.stream, res, (err) => {
      if (err) {
        logger.warn(`[NoteCells] file download stopped: ${err.message}`);
      }
    });
  }),
);

authed.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  return sendError(res, err);
});

router.use('/:conversationId', authed);

module.exports = router;
