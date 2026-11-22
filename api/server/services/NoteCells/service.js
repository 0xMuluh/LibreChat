const mongoose = require('mongoose');
const { createNoteService } = require('@librechat/api');
const models = require('./models');
const {
  startExecution,
  getExecutionStatus,
  fetchArtifactFromEngine,
  signalCancel,
  engineUnreachableError,
} = require('./engineClient');
const { bridgeConversationFiles } = require('./noteDataBridge');

module.exports = createNoteService({
  models,
  getConversationModel: () => mongoose.models.Conversation,
  getSharedLinkModel: () => mongoose.models.SharedLink,
  startExecution,
  getExecutionStatus,
  fetchArtifactFromEngine,
  signalCancel,
  engineUnreachableError,
  bridgeConversationFiles,
});
