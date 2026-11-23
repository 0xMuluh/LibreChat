const express = require('express');
const request = require('supertest');

const mockViewer = { current: null };
const mockNoteCells = {
  assertConversationAccess: jest.fn(),
  getCell: jest.fn(),
  getCellByBlockKey: jest.fn(),
  listCells: jest.fn(),
};

jest.mock('~/server/middleware/optionalJwtAuth', () => (req, _res, next) => {
  if (mockViewer.current) {
    req.user = mockViewer.current;
  }
  next();
});
jest.mock('~/server/services/NoteCells/service', () => mockNoteCells);

const storedCell = () => ({
  id: 'c1',
  conversationId: 'convo-private',
  blockKey: 'tool-call_1',
  revision: { id: 'r2', cellId: 'c1', revision: 2, language: 'r', content: 'edited()' },
  latestExecution: { id: 'e2', cellId: 'c1', status: 'completed', artifacts: [{ id: 'a1' }] },
});

describe('note routes: cells read through a share', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use('/api/notes', require('../notes'));
  });

  beforeEach(() => {
    mockViewer.current = null;
    mockNoteCells.getCell.mockResolvedValue(storedCell());
    mockNoteCells.getCellByBlockKey.mockResolvedValue(storedCell());
    mockNoteCells.listCells.mockResolvedValue([storedCell()]);
  });

  const sharedAccess = () =>
    mockNoteCells.assertConversationAccess.mockResolvedValue({
      conversationId: 'convo-private',
      userId: 'owner',
      isShared: true,
    });

  it('returns the latest revision and run without the note conversation id', async () => {
    sharedAccess();

    const res = await request(app).get('/api/notes/share1/cells/c1').expect(200);

    expect(mockNoteCells.assertConversationAccess).toHaveBeenCalledWith('share1', '', {
      readOnly: true,
    });
    expect(mockNoteCells.getCell).toHaveBeenCalledWith('convo-private', 'owner', 'c1');
    expect(res.body.conversationId).toBeUndefined();
    expect(res.body.revision.content).toBe('edited()');
    expect(res.body.latestExecution.id).toBe('e2');
    expect(res.body.latestExecution.artifacts[0].contentUrl).toBe(
      '/api/notes/share1/cells/c1/executions/e2/artifacts/a1/content',
    );
  });

  it('leaves the conversation id out of listed and blockKey cells too', async () => {
    sharedAccess();

    const list = await request(app).get('/api/notes/share1/cells').expect(200);
    const byKey = await request(app)
      .get('/api/notes/share1/cells')
      .query({ blockKey: 'tool-call_1' })
      .expect(200);

    expect(list.body.cells).toHaveLength(1);
    expect(list.body.cells[0].conversationId).toBeUndefined();
    expect(byKey.body.conversationId).toBeUndefined();
    expect(byKey.body.id).toBe('c1');
  });

  it("keeps the conversation id for the owner's own note", async () => {
    mockViewer.current = { id: 'owner' };
    mockNoteCells.assertConversationAccess.mockResolvedValue({
      conversationId: 'convo-private',
      userId: 'owner',
    });

    const res = await request(app).get('/api/notes/convo-private/cells/c1').expect(200);

    expect(res.body.conversationId).toBe('convo-private');
  });
});
