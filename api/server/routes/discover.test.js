const express = require('express');
const request = require('supertest');

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));
jest.mock('~/server/services/Discover', () => ({}));

const discoverRouter = require('./discover');

const spec = (name, extra = {}) => ({
  name,
  label: name,
  preset: { endpoint: 'openAI' },
  ...extra,
});

describe('GET /models', () => {
  const app = express();
  app.use('/', discoverRouter);
  const env = { ...process.env };

  beforeEach(() => {
    delete process.env.DISCOVER_SPECS;
    delete process.env.DISCOVER_DEFAULT_SPEC;
    mockGetAppConfig.mockResolvedValue({
      modelSpecs: { list: [spec('a', { default: true }), spec('b'), spec('c')] },
    });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const names = async () => {
    const res = await request(app).get('/models');
    return res.body.items.map((item) => [item.name, item.default]);
  };

  it('lists every spec when DISCOVER_SPECS is unset', async () => {
    expect(await names()).toEqual([
      ['a', true],
      ['b', false],
      ['c', false],
    ]);
  });

  it('lists only the DISCOVER_SPECS specs, in that order', async () => {
    process.env.DISCOVER_SPECS = 'c, missing ,a';
    expect(await names()).toEqual([
      ['c', false],
      ['a', true],
    ]);
  });

  it('keeps DISCOVER_DEFAULT_SPEC as the preselected model', async () => {
    process.env.DISCOVER_SPECS = 'a,b';
    process.env.DISCOVER_DEFAULT_SPEC = 'b';
    expect(await names()).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });
});
