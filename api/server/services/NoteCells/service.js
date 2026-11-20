const mongoose = require('mongoose');
const { createNoteService } = require('@librechat/api');
const models = require('./models');
const { executeOnEngine, fetchArtifactFromEngine, signalCancel } = require('./engineClient');
const { bridgeConversationFiles } = require('./noteDataBridge');

module.exports = createNoteService({
  models,
  getConversationModel: () => mongoose.models.Conversation,
  getSharedLinkModel: () => mongoose.models.SharedLink,
  executeOnEngine,
  fetchArtifactFromEngine,
  signalCancel,
  bridgeConversationFiles,
});
