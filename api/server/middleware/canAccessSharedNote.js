const mongoose = require('mongoose');
const { createSharedLinkAccessMiddleware } = require('@librechat/api');

/** The share page's own check (public link, login, or the people it is shared with), for
 *  the note routes, which carry the shareId as `:conversationId`. */
const canAccessSharedNote = createSharedLinkAccessMiddleware({
  mongoose,
  shareIdParam: 'conversationId',
});

module.exports = canAccessSharedNote;
