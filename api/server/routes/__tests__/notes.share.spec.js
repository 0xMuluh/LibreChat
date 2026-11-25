const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Constants } = require('librechat-data-provider');
const { createModels } = require('@librechat/data-schemas');

const mockViewer = { current: null };
const mockGate = { current: null };

jest.mock('~/server/middleware/optionalJwtAuth', () => (req, _res, next) => {
  if (mockViewer.current) {
    req.user = mockViewer.current;
  }
  next();
});
// The share page's access check has its own tests; here it lets the viewer in unless told.
jest.mock(
  '~/server/middleware/canAccessSharedNote',
  () => (req, res, next) => (mockGate.current ? mockGate.current(req, res, next) : next()),
);
jest.mock('~/server/services/NoteCells/engineClient', () => ({
  startExecution: jest.fn(),
  getExecutionStatus: jest.fn(),
  signalCancel: jest.fn(),
  engineUnreachableError: jest.fn(),
  noteHasDataFile: jest.fn(),
  uploadNoteDataFile: jest.fn(),
  fetchArtifactFromEngine: jest.fn(async () => ({
    buffer: Buffer.from('png-bytes'),
    contentType: 'image/png',
  })),
  streamArtifactFromEngine: jest.fn(async () => ({
    stream: require('stream').Readable.from([Buffer.from('a,b\n1,2\n')]),
    contentType: 'text/csv',
    contentLength: '8',
  })),
}));

createModels(mongoose);
const models = require('~/server/services/NoteCells/models');

const owner = 'owner-1';
const conversationId = 'convo-private';
const id = () => new mongoose.Types.ObjectId();
const ids = { shown: id(), running: id(), later: id(), loose: id() };

/** A cell with one revision, one finished run and one figure. */
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
    markdown: 'out',
  });
  const artifact = await models.NoteExecutionArtifact.create({
    executionId,
    conversationId,
    user: owner,
    artifactType: 'plot',
    relativePath: 'runs/cell_1/plot.png',
    mimeType: 'image/png',
  });
  await models.NoteCell.create({
    _id: cellId,
    conversationId,
    user: owner,
    blockKey,
    latestRevisionId: revisionId,
    latestExecutionId: executionId,
  });
  return { executionId: String(executionId), artifactId: String(artifact._id) };
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

/** Two turns; the share stops after the first answer, so the second turn's cell is later. */
async function seedNote() {
  const messages = await mongoose.models.Message.insertMany(
    [
      { messageId: 'u1', parentMessageId: Constants.NO_PARENT, isCreatedByUser: true, text: 'q1' },
      {
        messageId: 'a1',
        parentMessageId: 'u1',
        isCreatedByUser: false,
        text: '',
        // One finished cell (found by its cell id), one still running (found by its tool call).
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

  return {
    shown: await seedCell(ids.shown, 'tool-call_shown'),
    running: await seedCell(ids.running, 'tool-call_running'),
    later: await seedCell(ids.later, 'tool-call_later'),
    loose: await seedCell(ids.loose, 'composer-1'),
  };
}

describe('note routes: what a share exposes', () => {
  let mongoServer;
  let app;
  let runs;

  const cellUrl = (shareId, cellId) => `/api/notes/${shareId}/cells/${cellId}`;
  const artifactUrl = (shareId, cellId, run) =>
    `${cellUrl(shareId, cellId)}/executions/${run.executionId}/artifacts/${run.artifactId}/content`;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    app = express();
    app.use('/api/notes', require('../notes'));
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    mockViewer.current = null;
    mockGate.current = null;
    runs = await seedNote();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('lists only the cells the shared messages reference', async () => {
    const res = await request(app).get('/api/notes/share-files/cells').expect(200);

    const listed = res.body.cells.map((cell) => cell.id).sort();
    expect(listed).toEqual([String(ids.shown), String(ids.running)].sort());
    expect(res.body.cells.every((cell) => cell.conversationId === undefined)).toBe(true);
  });

  it('serves a referenced cell, its run and its figure', async () => {
    const cell = await request(app).get(cellUrl('share-files', ids.shown)).expect(200);
    expect(cell.body.latestExecution.artifacts).toHaveLength(1);

    await request(app)
      .get(`${cellUrl('share-files', ids.shown)}/executions/${runs.shown.executionId}`)
      .expect(200);
    const figure = await request(app)
      .get(artifactUrl('share-files', ids.shown, runs.shown))
      .expect(200);
    expect(figure.headers['content-type']).toBe('image/png');
    expect(figure.headers['content-disposition']).toBe(
      `inline; filename="plot.png"; filename*=UTF-8''plot.png`,
    );
  });

  it('streams a file the run wrote as a download, and not through a share without files', async () => {
    const file = await models.NoteExecutionArtifact.create({
      executionId: runs.shown.executionId,
      conversationId,
      user: owner,
      artifactType: 'file',
      relativePath: 'results/tulokset "ä".csv',
      mimeType: 'text/csv',
      byteSize: 8,
    });
    const run = { ...runs.shown, artifactId: String(file._id) };

    await request(app)
      .get(artifactUrl('share-bare', ids.shown, run))
      .expect(404);

    const res = await request(app)
      .get(artifactUrl('share-files', ids.shown, run))
      .expect(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="tulokset ___.csv"; filename*=UTF-8''tulokset%20%22%C3%A4%22.csv`,
    );
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('a,b\n1,2\n');
  });

  it('hides a cell from a message after the share point', async () => {
    await request(app).get(cellUrl('share-files', ids.later)).expect(404);
    await request(app)
      .get(`${cellUrl('share-files', ids.later)}/executions/${runs.later.executionId}`)
      .expect(404);
    await request(app)
      .get(`${cellUrl('share-files', ids.later)}/executions`)
      .expect(404);
    await request(app)
      .get(artifactUrl('share-files', ids.later, runs.later))
      .expect(404);
    await request(app)
      .get('/api/notes/share-files/cells')
      .query({ blockKey: 'tool-call_later' })
      .expect(404);
  });

  it('hides a cell that no shared message references', async () => {
    await request(app).get(cellUrl('share-files', ids.loose)).expect(404);
    await request(app)
      .get(artifactUrl('share-files', ids.loose, runs.loose))
      .expect(404);
    await request(app)
      .get('/api/notes/share-files/cells')
      .query({ blockKey: 'composer-1' })
      .expect(404);
  });

  it('finds a referenced cell by the key of its tool call', async () => {
    const res = await request(app)
      .get('/api/notes/share-files/cells')
      .query({ blockKey: 'tool-call_running' })
      .expect(200);
    expect(res.body.id).toBe(String(ids.running));
  });

  it('serves no figures when the share leaves out the files', async () => {
    await request(app)
      .get(artifactUrl('share-bare', ids.shown, runs.shown))
      .expect(404);

    const cell = await request(app).get(cellUrl('share-bare', ids.shown)).expect(200);
    expect(cell.body.latestExecution.artifacts).toEqual([]);
    const run = await request(app)
      .get(`${cellUrl('share-bare', ids.shown)}/executions/${runs.shown.executionId}`)
      .expect(200);
    expect(run.body.artifacts).toEqual([]);
    const list = await request(app).get('/api/notes/share-bare/cells').expect(200);
    expect(list.body.cells.every((c) => c.latestExecution.artifacts.length === 0)).toBe(true);
  });

  it('does not open a shared note by its conversation id', async () => {
    mockViewer.current = { id: 'someone-else' };
    await request(app).get(`/api/notes/${conversationId}/cells`).expect(404);
  });

  it('stops when the share page would turn the viewer away', async () => {
    mockGate.current = (_req, res) => res.status(401).json({ message: 'Authentication required' });
    await request(app).get(cellUrl('share-files', ids.shown)).expect(401);
  });

  it('gives the owner every cell of their own note, with figures', async () => {
    mockViewer.current = { id: owner };
    await mongoose.models.Conversation.create({
      conversationId,
      user: owner,
      title: 'Mine',
      endpoint: 'openAI',
    });

    const res = await request(app).get(`/api/notes/${conversationId}/cells`).expect(200);
    expect(res.body.cells).toHaveLength(4);
    await request(app)
      .get(artifactUrl(conversationId, ids.loose, runs.loose))
      .expect(200);
  });
});
