jest.mock('~/models', () => ({
  getImpactsTotals: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

const { getImpactsTotals } = require('~/models');
const impactsController = require('./Impacts');

const totals = (energy, gwp, partial = false) => ({
  energy: { min: energy, max: energy * 3 },
  gwp: { min: gwp, max: gwp * 3 },
  partial,
});

describe('impactsController', () => {
  const createResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the account total alone without a conversationId', async () => {
    getImpactsTotals.mockResolvedValue(totals(0.01, 0.004));
    const res = createResponse();

    await impactsController({ user: { id: 'user-1' }, query: {} }, res);

    expect(getImpactsTotals).toHaveBeenCalledTimes(1);
    expect(getImpactsTotals).toHaveBeenCalledWith({ user: 'user-1' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ account: totals(0.01, 0.004) });
  });

  it('returns the note and the account totals, with the partial flag of each', async () => {
    getImpactsTotals.mockImplementation(({ conversationId }) =>
      Promise.resolve(conversationId ? totals(0.002, 0.001, true) : totals(0.01, 0.004)),
    );
    const res = createResponse();

    await impactsController({ user: { id: 'user-1' }, query: { conversationId: 'convo-1' } }, res);

    expect(getImpactsTotals).toHaveBeenCalledWith({ user: 'user-1', conversationId: 'convo-1' });
    expect(res.json).toHaveBeenCalledWith({
      account: totals(0.01, 0.004),
      note: totals(0.002, 0.001, true),
    });
  });

  it('rejects a conversationId that is not a plain string', async () => {
    const res = createResponse();

    await impactsController({ user: { id: 'user-1' }, query: { conversationId: ['a', 'b'] } }, res);

    expect(getImpactsTotals).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('answers 500 when the totals cannot be read', async () => {
    getImpactsTotals.mockRejectedValue(new Error('db down'));
    const res = createResponse();

    await impactsController({ user: { id: 'user-1' }, query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
