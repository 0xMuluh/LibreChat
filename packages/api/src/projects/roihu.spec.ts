import type { RoihuConfig } from './roihu';
import { createRoihuClient, roihuConfig, validateLaunch, UserFacingError } from './roihu';

const config: RoihuConfig = {
  routerUrl: 'http://router',
  routerSecret: 'router-secret',
  firecrestUrl: 'https://fc/v1',
  system: 'cpu',
  imageTag: 'v1.41.0-roihu1',
  relayUrl: 'https://relay',
  relayFingerprint: 'fp',
  scriptsDir: '/scripts',
  appUrl: 'https://omicsbase.example',
};

const goodInput = { project: 'project_2010578', cores: 2, memory: 8, hours: 4, token: 'tok' };

/** In-memory stand-ins for the router's private interface and FirecREST. */
function fakeWorld(
  opts: {
    imageExists?: boolean;
    groups?: string[];
    failJobSubmit?: boolean;
    config?: RoihuConfig;
  } = {},
) {
  const routes: Record<
    string,
    { user: string; expires: number | null; meta: Record<string, unknown>; connected: boolean }
  > = {};
  const pairings: Record<string, string> = {};
  const jobs: Record<
    string,
    { state: string; start?: number; end?: number; body: Record<string, unknown> }
  > = {};
  const calls: string[] = [];
  let nextJob = 100;
  let tokenValid = true;

  const reply = (status: number, data?: unknown) =>
    ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) }) as Response;

  const fetchFake = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}`);
    if (u.host === 'router') {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer router-secret');
      const parts = u.pathname.split('/').filter(Boolean);
      if (method === 'GET' && parts.length === 1) {
        const user = u.searchParams.get('user');
        const mine = Object.entries(routes)
          .filter(([, r]) => r.user === user)
          .map(([route, r]) => ({
            route,
            expires: r.expires,
            meta: r.meta,
            connected: r.connected,
          }));
        return reply(200, { routes: mine });
      }
      if (method === 'POST' && parts.join('/') === 'routes') {
        const id = `r${Object.keys(routes).length + 1}`;
        routes[id] = { user: body.user, expires: 2e9, meta: body.meta, connected: false };
        return reply(201, {
          route: id,
          expires: 2e9,
          relay_remote: 'R:127.0.0.1:18100',
          relay_auth: `job-${id}:pw`,
          session_key: 'sk',
        });
      }
      if (method === 'POST' && parts.join('/') === 'links') {
        if (!String(body.pairing).startsWith('omicsbase-machine:')) {
          return reply(400, { error: 'not a pairing string' });
        }
        if (Object.values(routes).some((r) => r.user === body.user)) {
          return reply(409);
        }
        const id = `r${Object.keys(routes).length + 1}`;
        routes[id] = {
          user: body.user,
          expires: null,
          meta: { kind: 'linked', name: 'lab.example.org' },
          connected: true,
        };
        return reply(201, { route: id, expires: null });
      }
      if (method === 'POST' && parts.join('/') === 'pairings') {
        const code = `CODE${Object.keys(pairings).length + 1}`;
        pairings[code] = body.user;
        return reply(201, { code, expires: 2e9 });
      }
      if (method === 'POST' && parts.join('/') === 'pairings/claim') {
        const user = pairings[body.code];
        delete pairings[body.code];
        if (!user) {
          return reply(404);
        }
        if (Object.values(routes).some((r) => r.user === user)) {
          return reply(409);
        }
        const id = `r${Object.keys(routes).length + 1}`;
        routes[id] = {
          user,
          expires: null,
          meta: { kind: 'attached', name: body.name },
          connected: false,
        };
        return reply(201, {
          route: id,
          expires: null,
          relay_remote: 'R:127.0.0.1:18101',
          relay_auth: `job-${id}:pw`,
          session_key: 'attached-key',
          user,
        });
      }
      if (method === 'PUT' && parts[2] === 'meta') {
        routes[parts[1]].meta = body.meta;
        return reply(204);
      }
      if (method === 'PUT' && parts[2] === 'expires') {
        routes[parts[1]].expires = body.expires;
        return reply(204);
      }
      if (method === 'POST' && parts[2] === 'link') {
        return reply(200, { url: 'https://relay/roihu/open?c=once' });
      }
      if (method === 'DELETE') {
        delete routes[parts[1]];
        return reply(204);
      }
    }
    if (!tokenValid) {
      return reply(401, { message: 'invalid token' });
    }
    const p = u.pathname.replace('/v1', '');
    if (p === '/status/cpu/userinfo') {
      return reply(200, {
        user: { name: 'muluhger' },
        groups: (opts.groups ?? ['muluhger', 'project_2010578']).map((name) => ({ name })),
      });
    }
    if (p === '/filesystem/cpu/ops/mkdir') {
      return reply(201, {});
    }
    if (p === '/filesystem/cpu/ops/chmod') {
      return reply(200, {});
    }
    if (p === '/filesystem/cpu/ops/stat') {
      return opts.imageExists
        ? reply(200, { output: {} })
        : reply(404, { message: 'no such file' });
    }
    if (p === '/compute/cpu/jobs' && method === 'POST') {
      const isPrep = body.job.name === 'omicsbase-reports-prepare';
      if (opts.failJobSubmit && !isPrep) {
        return reply(400, { message: 'bad' });
      }
      const id = String(nextJob++);
      jobs[id] = { state: 'PENDING', body: body.job };
      return reply(201, { jobId: id });
    }
    const jobMatch = p.match(/^\/compute\/cpu\/jobs\/(\d+)$/);
    if (jobMatch && method === 'GET') {
      return reply(200, {
        jobs: [
          {
            jobId: jobMatch[1],
            status: { state: jobs[jobMatch[1]].state },
            time: { start: jobs[jobMatch[1]].start ?? 0, end: jobs[jobMatch[1]].end ?? 0 },
          },
        ],
      });
    }
    if (jobMatch && method === 'DELETE') {
      jobs[jobMatch[1]].state = 'CANCELLED';
      return reply(204);
    }
    return reply(404);
  }) as unknown as typeof fetch;

  const client = createRoihuClient({
    config: () => opts.config ?? config,
    fetch: fetchFake,
    encrypt: async (v) => `enc(${v})`,
    decrypt: async (v) => v.replace(/^enc\((.*)\)$/, '$1'),
    readScript: (_dir, name) => `#!/bin/bash\n# ${name}\necho run\n`,
  });
  return {
    client,
    routes,
    jobs,
    calls,
    expireToken: () => {
      tokenValid = false;
    },
  };
}

describe('validateLaunch', () => {
  it('accepts the form defaults', () => {
    expect(validateLaunch(goodInput).input).toEqual(goodInput);
  });

  it('reports each invalid field', () => {
    const { errors } = validateLaunch({
      project: 'proj',
      cores: 9,
      memory: 1.5,
      hours: 0,
      token: ' ',
    });
    expect(Object.keys(errors ?? {}).sort()).toEqual([
      'cores',
      'hours',
      'memory',
      'project',
      'token',
    ]);
  });
});

describe('createRoihuClient', () => {
  it('first launch in a project prepares the image, then queues the session after it', async () => {
    const w = fakeWorld();
    const view = await w.client.launch('u1', goodInput);
    expect(view.state).toBe('preparing');

    const [prep, session] = Object.values(w.jobs);
    expect(prep.body).toMatchObject({
      name: 'omicsbase-reports-prepare',
      account: 'project_2010578',
      memoryPerNode: 65536,
      env: { REPORTS_IMAGES: '/scratch/project_2010578/omicsbase-reports/images' },
    });
    expect(session.body).toMatchObject({
      partition: 'interactive',
      cpusPerTask: 2,
      memoryPerNode: 8192,
      timeLimit: 240,
      workingDirectory: '/scratch/project_2010578/omicsbase-reports/users/muluhger',
      env: { SESSION_KEY: 'sk', RELAY_AUTH: 'job-r1:pw', RELAY_REMOTE: 'R:127.0.0.1:18100' },
    });
    expect(session.body.script).toContain('#SBATCH --dependency=afterok:100\n');

    const meta = w.routes.r1.meta;
    expect(meta).toMatchObject({ jobId: '101', prepJobId: '100', token: 'enc(tok)' });
    expect(JSON.stringify(meta)).not.toContain('"tok"');
  });

  it('skips preparation when the project already has the image', async () => {
    const w = fakeWorld({ imageExists: true });
    expect((await w.client.launch('u1', goodInput)).state).toBe('queued');
    expect(Object.values(w.jobs)).toHaveLength(1);
    expect(Object.values(w.jobs)[0].body.script).not.toContain('--dependency');
  });

  it('refuses a project the CSC account is not a member of, before creating anything', async () => {
    const w = fakeWorld({ groups: ['muluhger', 'project_1111111'] });
    await expect(w.client.launch('u1', goodInput)).rejects.toMatchObject({ status: 403 });
    expect(w.routes).toEqual({});
    expect(w.jobs).toEqual({});
  });

  it('undoes everything when Roihu rejects the session job', async () => {
    const w = fakeWorld({ failJobSubmit: true });
    await expect(w.client.launch('u1', goodInput)).rejects.toBeInstanceOf(UserFacingError);
    expect(w.routes).toEqual({});
    expect(w.jobs['100'].state).toBe('CANCELLED');
  });

  it('allows one session per user', async () => {
    const w = fakeWorld({ imageExists: true });
    await w.client.launch('u1', goodInput);
    await expect(w.client.launch('u1', goodInput)).rejects.toMatchObject({ status: 409 });
  });

  it('reports each state of a session', async () => {
    const w = fakeWorld();
    await w.client.launch('u1', goodInput);
    expect((await w.client.view('u1')).state).toBe('preparing');

    w.jobs['100'].state = 'COMPLETED';
    expect((await w.client.view('u1')).state).toBe('queued');

    w.jobs['101'].state = 'RUNNING';
    expect((await w.client.view('u1')).state).toBe('starting');

    w.routes.r1.connected = true;
    w.jobs['101'].end = 1795000000;
    expect(await w.client.view('u1')).toEqual({
      state: 'running',
      project: 'project_2010578',
      cores: 2,
      memory: 8,
      hours: 4,
      endsAt: 1795000000,
      launchedAt: expect.any(Number),
    });

    w.jobs['101'].state = 'TIMEOUT';
    expect(await w.client.view('u1')).toMatchObject({
      state: 'ended',
      message: 'Your session reached its time limit of 4 hours.',
    });
    expect(w.routes).toEqual({});
    expect((await w.client.view('u1')).state).toBe('none');
  });

  it('a failed preparation cancels the waiting session job and frees the launch form', async () => {
    const w = fakeWorld();
    await w.client.launch('u1', goodInput);
    w.jobs['100'].state = 'FAILED';
    expect(await w.client.view('u1')).toEqual({
      state: 'ended',
      message: 'Preparing the Reports image failed. Launch again to retry.',
    });
    expect(w.jobs['101'].state).toBe('CANCELLED');
    expect(w.routes).toEqual({});
    expect((await w.client.launch('u1', goodInput)).state).toBe('preparing');
  });

  it('the route lasts from the job start for its hours, however long it queued', async () => {
    const w = fakeWorld({ imageExists: true });
    await w.client.launch('u1', goodInput);
    w.jobs['100'].state = 'RUNNING';
    w.jobs['100'].start = 1795000000;
    await w.client.view('u1');
    expect(w.routes.r1.expires).toBe(1795000000 + 4 * 3600 + 15 * 60);
    const puts = w.calls.filter((c) => c === 'PUT /routes/r1/expires');
    await w.client.view('u1');
    expect(w.calls.filter((c) => c === 'PUT /routes/r1/expires')).toEqual(puts);
  });

  it("shows the token's expiry when the token is a JWT", async () => {
    const w = fakeWorld({ imageExists: true });
    const payload = Buffer.from(JSON.stringify({ exp: 1795086400 })).toString('base64url');
    await w.client.launch('u1', { ...goodInput, token: `h.${payload}.s` });
    expect(await w.client.view('u1')).toMatchObject({ tokenExpires: 1795086400 });
  });

  it('keeps a running session usable after the token expires, and says so', async () => {
    const w = fakeWorld({ imageExists: true });
    await w.client.launch('u1', goodInput);
    w.routes.r1.connected = true;
    w.expireToken();
    const view = await w.client.view('u1');
    expect(view.state).toBe('running');
    expect(view.message).toMatch(/expired/);
  });

  it('stop cancels the jobs and removes the route', async () => {
    const w = fakeWorld();
    await w.client.launch('u1', goodInput);
    expect((await w.client.stop('u1')).state).toBe('ended');
    expect(w.jobs['100'].state).toBe('CANCELLED');
    expect(w.jobs['101'].state).toBe('CANCELLED');
    expect(w.routes).toEqual({});
  });

  it('open gives a one-time link only to the session owner', async () => {
    const w = fakeWorld({ imageExists: true });
    await w.client.launch('u1', goodInput);
    expect(await w.client.openLink('u1')).toBe('https://relay/roihu/open?c=once');
    await expect(w.client.openLink('u2')).rejects.toMatchObject({ status: 404 });
  });

  it('a pairing code attaches one machine, which shows by name until it is disconnected', async () => {
    const w = fakeWorld();
    const pairing = await w.client.pair('u1');
    expect(pairing.command).toBe(
      'docker run -d --restart unless-stopped --name omicsbase-reports ' +
        '-v omicsbase-reports:/home/openhands -v omicsbase-projects:/projects ' +
        'ghcr.io/0xmuluh/omicsbase-reports:v1.41.0-roihu1 ' +
        `https://omicsbase.example --pair ${pairing.code} --name "$(hostname)"`,
    );
    expect(await w.client.claim(pairing.code, 'lab-pc')).toEqual({
      relayUrl: 'https://relay',
      relayFingerprint: 'fp',
      relayRemote: 'R:127.0.0.1:18101',
      relayAuth: 'job-r1:pw',
      sessionKey: 'attached-key',
    });
    await expect(w.client.claim(pairing.code, 'lab-pc')).rejects.toMatchObject({ status: 404 });
    expect(await w.client.view('u1')).toEqual({ state: 'offline', machine: 'lab-pc' });
    w.routes.r1.connected = true;
    expect(await w.client.view('u1')).toEqual({ state: 'running', machine: 'lab-pc' });
    expect(await w.client.openLink('u1')).toBe('https://relay/roihu/open?c=once');
    expect((await w.client.stop('u1')).state).toBe('ended');
    expect(w.routes).toEqual({});
    expect(w.calls.some((call) => call.includes('/compute/'))).toBe(false);
  });

  it('one session per user across Roihu and attached machines', async () => {
    const w = fakeWorld({ imageExists: true });
    await w.client.launch('u1', goodInput);
    await expect(w.client.pair('u1')).rejects.toMatchObject({ status: 409 });
    const other = await w.client.pair('u2');
    await w.client.claim(other.code, 'pc');
    await expect(w.client.launch('u2', goodInput)).rejects.toMatchObject({ status: 409 });
  });

  it('with a relay, a pasted pairing string is refused without reaching the router', async () => {
    const w = fakeWorld();
    await expect(w.client.link('u1', 'omicsbase-machine:abc')).rejects.toMatchObject({
      status: 404,
    });
    expect(w.calls.some((call) => call.includes('/links'))).toBe(false);
  });

  it('a local install links the machine whose pairing string the user pasted', async () => {
    const local = roihuConfig({
      ROIHU_ROUTER_URL: 'http://router',
      ROIHU_ROUTER_SECRET: 'router-secret',
    });
    const w = fakeWorld({ config: local! });
    await expect(w.client.link('u1', 'hello')).rejects.toMatchObject({ status: 400 });
    expect(await w.client.link('u1', 'omicsbase-machine:abc')).toEqual({
      state: 'running',
      machine: 'lab.example.org',
    });
    await expect(w.client.link('u1', 'omicsbase-machine:abc')).rejects.toMatchObject({
      status: 409,
    });
    const stopped = await w.client.stop('u1');
    expect(stopped.state).toBe('ended');
    expect(stopped.message).toContain('Disconnected from lab.example.org');
    expect(w.routes).toEqual({});
  });

  it('a local install has no Roihu launch or relay pairing', async () => {
    const local = roihuConfig({
      ROIHU_ROUTER_URL: 'http://router',
      ROIHU_ROUTER_SECRET: 'router-secret',
    });
    expect(roihuConfig({ ROIHU_IMAGE_TAG: 'x' })).toBeNull();
    const w = fakeWorld({ config: local! });
    await expect(w.client.launch('u1', goodInput)).rejects.toMatchObject({ status: 503 });
    await expect(w.client.pair('u1')).rejects.toMatchObject({ status: 503 });
    expect(w.calls.every((call) => call === 'GET /routes')).toBe(true);
  });

  it('a local install gives the command that makes a machine print its pairing string', async () => {
    const local = roihuConfig({
      ROIHU_ROUTER_URL: 'http://router',
      ROIHU_ROUTER_SECRET: 'router-secret',
      ROIHU_IMAGE_TAG: 'v1.41.0-roihu4',
    });
    const w = fakeWorld({ config: local! });
    expect(await w.client.pair('u1')).toEqual({
      command:
        'docker run -d --restart unless-stopped --name omicsbase-reports -p 8443:8443 ' +
        '-v omicsbase-reports:/home/openhands -v omicsbase-projects:/projects ' +
        'ghcr.io/0xmuluh/omicsbase-reports:v1.41.0-roihu4 ' +
        'serve --address <name or IP of that computer>',
    });
  });
});
