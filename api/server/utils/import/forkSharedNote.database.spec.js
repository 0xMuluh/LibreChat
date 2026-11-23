const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Constants } = require('librechat-data-provider');
const { createModels } = require('@librechat/data-schemas');

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({ interfaceConfig: {} }),
  getEndpointsConfig: jest.fn().mockResolvedValue({ openAI: { userProvide: false } }),
}));
jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({ openAI: ['gpt-4o'] }),
}));
jest.mock('~/server/services/NoteCells/engineClient', () => ({
  copyNoteFiles: jest.fn().mockResolvedValue({ copied: true }),
}));

createModels(mongoose);
const models = require('~/server/services/NoteCells/models');
const { copyNoteFiles } = require('~/server/services/NoteCells/engineClient');
const { cloneNoteConversation } = require('~/server/services/NoteCells/cloneNoteConversation');
const { forkSharedConversation } = require('./fork');

const owner = 'owner-1';
const viewer = 'viewer-1';
const conversationId = 'convo-private';
const id = () => new mongoose.Types.ObjectId();
const ids = { shown: id(), running: id(), later: id(), loose: id() };

async function seedCell(cellId, blockKey) {
  const revisionId = id();
  const executionId = id();
  await models.NoteCellRevision.create({
    _id: revisionId,
    cellId,
    conversationId,
    user: owner,
    revision: 1,
    content: `code for ${blockKey}`,
  });
  await models.NoteCellExecution.create({
    _id: executionId,
    cellId,
    revisionId,
    conversationId,
    user: owner,
    status: 'completed',
  });
  await models.NoteExecutionArtifact.create({
    executionId,
    conversationId,
    user: owner,
    artifactType: 'plot',
    relativePath: 'runs/cell_1/plot.png',
  });
  await models.NoteCell.create({
    _id: cellId,
    conversationId,
    user: owner,
    blockKey,
    latestRevisionId: revisionId,
    latestExecutionId: executionId,
  });
}

const toolCall = (callId, cellId) => ({
  type: 'tool_call',
  tool_call: {
    id: callId,
    name: 'execute_r_cell',
    args: '{"code":"1"}',
    ...(cellId && {
      output: `<!-- noteCell cellId=${cellId} executionId=e status=completed -->\n[cell_id: "${cellId}"]`,
    }),
  },
});

/** Two turns; the share stops after the first answer. */
async function seedNote() {
  const messages = await mongoose.models.Message.insertMany(
    [
      { messageId: 'u1', parentMessageId: Constants.NO_PARENT, isCreatedByUser: true, text: 'q1' },
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        text: '',
        content: [toolCall('call_shown', ids.shown), toolCall('call_running')],
      },
      { messageId: 'u2', parentMessageId: 'a1', isCreatedByUser: true, text: 'q2' },
      {
        messageId: 'a2',
        parentMessageId: 'u2',
        isCreatedByUser: false,
        text: '',
        content: [toolCall('call_later', ids.later)],
      },
    ].map((message) => ({ ...message, conversationId, user: owner })),
  );
  const share = (shareId, snapshotFiles) => ({
    shareId,
    conversationId,
    user: owner,
    title: 'Shared note',
    targetMessageId: 'a1',
    snapshotFiles,
    messages: messages.map((message) => message._id),
  });
  await mongoose.models.SharedLink.create([share('share-files', true), share('share-bare', false)]);
  await seedCell(ids.shown, 'tool-call_shown');
  await seedCell(ids.running, 'tool-call_running');
  await seedCell(ids.later, 'tool-call_later');
  await seedCell(ids.loose, 'composer-1');
}

const copiedCells = (target) =>
  models.NoteCell.find({ conversationId: target }).sort({ blockKey: 1 }).lean();
const copiedArtifacts = (target) =>
  models.NoteExecutionArtifact.countDocuments({ conversationId: target });

describe('forking a shared note copies only what the share shows', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    await seedNote();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('copies the referenced cells with their runs and figures', async () => {
    const result = await forkSharedConversation({ shareId: 'share-files', requestUserId: viewer });
    const target = result.conversation.conversationId;

    const cells = await copiedCells(target);
    expect(cells.map((cell) => cell.blockKey)).toEqual(['tool-call_running', 'tool-call_shown']);
    expect(cells.every((cell) => cell.user === viewer)).toBe(true);
    expect(await copiedArtifacts(target)).toBe(2);
    expect(copyNoteFiles).toHaveBeenCalledWith(conversationId, target, { includeData: true });

    // The copied tool output points at the copied cell, not the owner's.
    const answer = await mongoose.models.Message.findOne({
      conversationId: target,
      isCreatedByUser: false,
    }).lean();
    const shownCopy = cells.find((cell) => cell.blockKey === 'tool-call_shown');
    expect(answer.content[0].tool_call.output).toContain(String(shownCopy._id));
  });

  it('copies no data and no figures when the share leaves out the files', async () => {
    const result = await forkSharedConversation({ shareId: 'share-bare', requestUserId: viewer });
    const target = result.conversation.conversationId;

    expect(await copiedCells(target)).toHaveLength(2);
    expect(await copiedArtifacts(target)).toBe(0);
    expect(copyNoteFiles).toHaveBeenCalledWith(conversationId, target, { includeData: false });
  });

  it('still copies every cell when the owner duplicates their own note', async () => {
    await cloneNoteConversation({
      sourceConversationId: conversationId,
      targetConversationId: 'owner-copy',
      targetUserId: owner,
    });

    expect(await copiedCells('owner-copy')).toHaveLength(4);
    expect(await copiedArtifacts('owner-copy')).toBe(4);
  });
});
