process.env.DOMAIN_CLIENT = 'https://omicsbase.utu.fi';

const { applyPublicPageMeta, summarize } = require('./publicPageMeta');

const SHELL =
  '<html><head><meta name="description" content="OmicsBase - platform" />' +
  '<title>OmicsBase</title></head><body><div id="root"></div></body></html>';

const json = (status, body) => ({ ok: status === 200, status, json: async () => body });

function makeRes() {
  const headers = { 'X-Robots-Tag': 'noindex' };
  return { headers, removeHeader: (name) => delete headers[name] };
}

const req = (path, hostname = 'omicsbase.utu.fi') => ({ method: 'GET', path, hostname });

const PUBLIC_SHARE = {
  title: 'Cell types <versus> "domains"',
  updatedAt: '2026-10-05T01:16:05.009Z',
  messages: [
    {
      isCreatedByUser: true,
      text: 'Load the **hippocampus** data\n\n```r\nx <- 1\n```\ninto a SpatialExperiment.',
    },
    { isCreatedByUser: false, text: '' },
  ],
};
const CELLS = {
  cells: [
    {
      position: 2,
      latestExecution: { artifacts: [{ artifactType: 'plot', contentUrl: '/api/notes/s/second' }] },
    },
    {
      position: 1,
      latestExecution: {
        artifacts: [
          { artifactType: 'table' },
          { artifactType: 'plot', contentUrl: '/api/notes/s/first' },
        ],
      },
    },
  ],
};

describe('applyPublicPageMeta', () => {
  let n = 0;
  const fresh = () => `share_${++n}_abcdef`;

  afterEach(() => {
    delete global.fetch;
  });

  it('tags a public note and drops noindex', async () => {
    global.fetch = jest.fn(async (url) =>
      url.includes('/cells') ? json(200, CELLS) : json(200, PUBLIC_SHARE),
    );
    const id = fresh();
    const res = makeRes();
    const html = await applyPublicPageMeta(req(`/share/${id}`), res, SHELL);

    expect(res.headers['X-Robots-Tag']).toBeUndefined();
    expect(html).toContain(
      '<title>Cell types &lt;versus&gt; &quot;domains&quot; | OmicsBase</title>',
    );
    expect(html).toContain(
      '<meta name="description" content="Load the hippocampus data into a SpatialExperiment." />',
    );
    expect(html).toContain(`<link rel="canonical" href="https://omicsbase.utu.fi/share/${id}" />`);
    expect(html).toContain(
      '<meta property="og:image" content="https://omicsbase.utu.fi/api/notes/s/first" />',
    );
    expect(html).toContain('summary_large_image');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/share/${id}`),
      expect.anything(),
    );
  });

  it('writes a readable copy of the note into the React root', async () => {
    const share = {
      title: 'A note',
      messages: [
        { isCreatedByUser: true, text: 'Plot the data' },
        {
          isCreatedByUser: false,
          content: [
            { type: 'think', think: 'private reasoning' },
            { type: 'text', text: 'Here is **the** plot:\n\n- one\n- two' },
            {
              type: 'tool_call',
              tool_call: {
                name: 'execute_r_cell_mcp_notethreads',
                args: JSON.stringify({ code: 'x <- "<script>alert(1)</script>"\nplot(x)' }),
                output:
                  '<!-- noteCell cellId=abc123 status=ok -->\n[cell_id: "abc123"]\n```\n[1] 42\n```\n![Plot](https://x/y.png)',
              },
            },
          ],
        },
      ],
    };
    const cells = {
      cells: [
        {
          id: 'abc123',
          position: 0,
          latestExecution: {
            artifacts: [{ artifactType: 'plot', contentUrl: '/api/notes/s/plot' }],
          },
        },
      ],
    };
    global.fetch = jest.fn(async (url) =>
      url.includes('/cells') ? json(200, cells) : json(200, share),
    );
    const shell = SHELL.replace(
      '<div id="root"></div>',
      '<div id="root"><div id="loading-container"></div></div>',
    );
    const html = await applyPublicPageMeta(req(`/share/${fresh()}`), makeRes(), shell);

    const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    expect(html.indexOf('<article')).toBeGreaterThan(html.indexOf('<div id="root">'));
    expect(article).toContain('<h2>Plot the data</h2>');
    expect(article).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(article).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(article).not.toContain('<script>');
    expect(article).toContain('<pre>[1] 42</pre>');
    expect(article).toContain('<img src="/api/notes/s/plot"');
    expect(article).not.toContain('private reasoning');
    expect(article).not.toContain('https://x/y.png');
  });

  it('leaves a note that is not public untouched', async () => {
    global.fetch = jest.fn(async () => json(401, null));
    const res = makeRes();
    const html = await applyPublicPageMeta(req(`/share/${fresh()}`), res, SHELL);
    expect(html).toBe(SHELL);
    expect(res.headers['X-Robots-Tag']).toBe('noindex');
  });

  it('keeps noindex and does not cache when the share API is rate limited', async () => {
    const id = fresh();
    global.fetch = jest.fn(async () => json(429, null));
    const res = makeRes();
    expect(await applyPublicPageMeta(req(`/share/${id}`), res, SHELL)).toBe(SHELL);
    expect(res.headers['X-Robots-Tag']).toBe('noindex');

    global.fetch = jest.fn(async (url) =>
      url.includes('/cells') ? json(200, CELLS) : json(200, PUBLIC_SHARE),
    );
    const res2 = makeRes();
    await applyPublicPageMeta(req(`/share/${id}`), res2, SHELL);
    expect(res2.headers['X-Robots-Tag']).toBeUndefined();
  });

  it('tags the front page', async () => {
    global.fetch = jest.fn();
    const res = makeRes();
    const html = await applyPublicPageMeta(req('/'), res, SHELL);
    expect(res.headers['X-Robots-Tag']).toBeUndefined();
    expect(html).toContain('<link rel="canonical" href="https://omicsbase.utu.fi/" />');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers HEAD like GET', async () => {
    global.fetch = jest.fn();
    const res = makeRes();
    await applyPublicPageMeta(
      { method: 'HEAD', path: '/', hostname: 'omicsbase.utu.fi' },
      res,
      SHELL,
    );
    expect(res.headers['X-Robots-Tag']).toBeUndefined();
  });

  it('leaves other paths and other hosts untouched', async () => {
    global.fetch = jest.fn();
    for (const r of [
      req('/c/new'),
      req('/login'),
      req('/', 'other.example.org'),
      req('/share/abcdefgh', 'other.example.org'),
    ]) {
      const res = makeRes();
      expect(await applyPublicPageMeta(r, res, SHELL)).toBe(SHELL);
      expect(res.headers['X-Robots-Tag']).toBe('noindex');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('summarize', () => {
  it('cuts long text at a word boundary', () => {
    const out = summarize('word '.repeat(60), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('…')).toBe(true);
  });
});
