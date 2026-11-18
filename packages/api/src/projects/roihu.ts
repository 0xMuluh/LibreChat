import fs from 'fs';
import path from 'path';
import { logger, encryptV2, decryptV2 } from '@librechat/data-schemas';
import type { Request, Response } from 'express';

/**
 * Reports on Roihu: each user's Reports agent runs as their own Slurm job on CSC's Roihu,
 * submitted through FirecREST with the user's CSC access token, and reached through its own
 * route on the OmicsBase relay (deployment/roihu in the omicsbase repo).
 */

export interface RoihuConfig {
  routerUrl: string;
  routerSecret: string;
  firecrestUrl: string;
  system: string;
  imageTag: string;
  relayUrl: string;
  relayFingerprint: string;
  scriptsDir: string;
}

/** Reads the configuration; null when Reports on Roihu is not set up on this deployment. */
export function roihuConfig(env: NodeJS.ProcessEnv = process.env): RoihuConfig | null {
  const required = [
    'ROIHU_ROUTER_URL',
    'ROIHU_ROUTER_SECRET',
    'ROIHU_IMAGE_TAG',
    'ROIHU_RELAY_URL',
    'ROIHU_RELAY_FINGERPRINT',
    'ROIHU_SCRIPTS_DIR',
  ];
  if (required.some((name) => !env[name])) {
    return null;
  }
  return {
    routerUrl: env.ROIHU_ROUTER_URL as string,
    routerSecret: env.ROIHU_ROUTER_SECRET as string,
    firecrestUrl: env.ROIHU_FIRECREST_URL || 'https://api.roihu.csc.fi/v1',
    system: env.ROIHU_FIRECREST_SYSTEM || 'cpu',
    imageTag: env.ROIHU_IMAGE_TAG as string,
    relayUrl: env.ROIHU_RELAY_URL as string,
    relayFingerprint: env.ROIHU_RELAY_FINGERPRINT as string,
    scriptsDir: env.ROIHU_SCRIPTS_DIR as string,
  };
}

export interface LaunchInput {
  project: string;
  cores: number;
  memory: number;
  hours: number;
  token: string;
}

/** Same rules as the launch form; returns an error message per invalid field. */
export function validateLaunch(body: unknown): {
  input?: LaunchInput;
  errors?: Record<string, string>;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const whole = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (typeof b.project !== 'string' || !/^project_\d{7}$/.test(b.project)) {
    errors.project = 'Enter a CSC project in the form project_1234567.';
  }
  if (!whole(b.cores, 1, 8)) {
    errors.cores = 'Enter a whole number from 1 to 8.';
  }
  if (!whole(b.memory, 2, 64)) {
    errors.memory = 'Enter a whole number from 2 to 64.';
  }
  if (!whole(b.hours, 1, 36)) {
    errors.hours = 'Enter a whole number from 1 to 36.';
  }
  if (typeof b.token !== 'string' || !b.token.trim() || b.token.length > 16384) {
    errors.token = 'Paste your CSC access token.';
  }
  if (Object.keys(errors).length) {
    return { errors };
  }
  return {
    input: {
      project: b.project as string,
      cores: b.cores as number,
      memory: b.memory as number,
      hours: b.hours as number,
      token: (b.token as string).trim(),
    },
  };
}

export type SessionState =
  | 'none'
  | 'preparing'
  | 'queued'
  | 'starting'
  | 'running'
  | 'ended'
  | 'unknown';

export interface SessionView {
  state: SessionState;
  project?: string;
  cores?: number;
  memory?: number;
  hours?: number;
  endsAt?: number;
  message?: string;
}

interface RouteMeta {
  project: string;
  cscUser: string;
  cores: number;
  memory: number;
  hours: number;
  jobId?: string;
  prepJobId?: string;
  token: string;
}

interface JobInfo {
  state: string;
  end?: number;
}

interface RouterRoute {
  route: string;
  expires: number;
  meta: RouteMeta;
  connected: boolean;
}

export interface RoihuDeps {
  config: () => RoihuConfig | null;
  fetch: typeof fetch;
  encrypt?: (value: string) => Promise<string>;
  decrypt?: (value: string) => Promise<string>;
  readScript?: (dir: string, name: string) => string;
}

export class UserFacingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const ENDED = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMEOUT',
  'NODE_FAIL',
  'OUT_OF_MEMORY',
  'PREEMPTED',
  'BOOT_FAIL',
  'DEADLINE',
]);

const ENDED_MESSAGE: Record<string, string> = {
  TIMEOUT: 'Your session reached its time limit.',
  CANCELLED: 'Your session was stopped.',
};

/** First word of a Slurm state ("CANCELLED by 123" -> "CANCELLED"). */
function slurmState(state: unknown): string {
  return String(state ?? '')
    .split(/\s+/)[0]
    .toUpperCase();
}

interface AuthedRequest extends Request {
  user?: { id: string; _id?: { toString(): string } };
}

export interface RoihuClient {
  view(userId: string): Promise<SessionView>;
  launch(userId: string, input: LaunchInput): Promise<SessionView>;
  openLink(userId: string): Promise<string>;
  stop(userId: string): Promise<SessionView>;
}

type Handler = (req: AuthedRequest, res: Response) => Promise<Response>;

export interface RoihuHandlers {
  getSession: Handler;
  launchSession: Handler;
  openSession: Handler;
  stopSession: Handler;
}

export function createRoihuClient(deps: RoihuDeps): RoihuClient {
  const encrypt = deps.encrypt ?? encryptV2;
  const decrypt = deps.decrypt ?? decryptV2;
  const readScript =
    deps.readScript ??
    ((dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8'));

  function config(): RoihuConfig {
    const c = deps.config();
    if (!c) {
      throw new UserFacingError(503, 'Reports on Roihu is not set up on this server.');
    }
    return c;
  }

  async function router(method: string, route: string, body?: unknown) {
    const c = config();
    const res = await deps.fetch(`${c.routerUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${c.routerSecret}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  async function firecrest(token: string, method: string, route: string, body?: unknown) {
    const c = config();
    const res = await deps.fetch(`${c.firecrestUrl}${route.replace('{system}', c.system)}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 401) {
      throw new UserFacingError(
        401,
        'Your CSC access token was not accepted. It may have expired; get a new one from MyCSC.',
      );
    }
    return { status: res.status, data: data as Record<string, unknown> };
  }

  async function liveRoute(userId: string): Promise<RouterRoute | null> {
    const { status, data } = await router('GET', `/routes?user=${encodeURIComponent(userId)}`);
    if (status !== 200) {
      throw new Error(`router answered ${status}`);
    }
    return (data?.routes?.[0] as RouterRoute) ?? null;
  }

  /** Slurm state of a job and, once it runs, its end time (start plus time limit). */
  async function jobInfo(token: string, jobId?: string): Promise<JobInfo | null> {
    if (!jobId) {
      return null;
    }
    const { status, data } = await firecrest(token, 'GET', `/compute/{system}/jobs/${jobId}`);
    if (status !== 200) {
      return null;
    }
    const job = (
      data?.jobs as
        | Array<{ status?: { state?: string }; time?: { end?: number | null } }>
        | undefined
    )?.[0];
    if (!job) {
      return null;
    }
    const end = job.time?.end;
    return { state: slurmState(job.status?.state), end: end && end > 0 ? end : undefined };
  }

  async function removeRoute(userId: string, route: string) {
    await router('DELETE', `/routes/${route}?user=${encodeURIComponent(userId)}`);
  }

  async function view(userId: string): Promise<SessionView> {
    const r = await liveRoute(userId);
    if (!r) {
      return { state: 'none' };
    }
    const m = r.meta;
    const base = { project: m.project, cores: m.cores, memory: m.memory, hours: m.hours };
    let token: string;
    try {
      token = await decrypt(m.token);
    } catch {
      return { ...base, state: r.connected ? 'running' : 'unknown' };
    }
    let prepInfo: JobInfo | null;
    let jobInfoNow: JobInfo | null;
    try {
      [prepInfo, jobInfoNow] = await Promise.all([
        jobInfo(token, m.prepJobId),
        jobInfo(token, m.jobId),
      ]);
    } catch (e) {
      if (e instanceof UserFacingError && e.status === 401) {
        return {
          ...base,
          state: r.connected ? 'running' : 'unknown',
          message:
            'Your CSC access token has expired, so OmicsBase can no longer check or stop this session.',
        };
      }
      throw e;
    }
    const prep = prepInfo?.state ?? null;
    const job = jobInfoNow?.state ?? null;
    if (job && ENDED.has(job)) {
      await removeRoute(userId, r.route);
      return {
        state: 'ended',
        message: ENDED_MESSAGE[job] ?? `Your session ended (${job.toLowerCase()}).`,
      };
    }
    if (prep && ENDED.has(prep) && prep !== 'COMPLETED') {
      return {
        ...base,
        state: 'ended',
        message: 'Preparing the Reports image failed; stop and try again.',
      };
    }
    if (prep === 'PENDING' || prep === 'RUNNING') {
      return { ...base, state: 'preparing' };
    }
    if (job === 'PENDING') {
      return { ...base, state: 'queued' };
    }
    if (job === 'RUNNING') {
      return { ...base, endsAt: jobInfoNow?.end, state: r.connected ? 'running' : 'starting' };
    }
    return { ...base, state: 'unknown' };
  }

  async function launch(userId: string, input: LaunchInput): Promise<SessionView> {
    const c = config();
    if (await liveRoute(userId)) {
      throw new UserFacingError(409, 'You already have a Reports session on Roihu. Stop it first.');
    }
    const info = await firecrest(input.token, 'GET', '/status/{system}/userinfo');
    const user = (info.data?.user as { name?: string } | undefined)?.name;
    if (info.status !== 200 || !user) {
      throw new UserFacingError(502, 'Roihu did not answer. Try again in a moment.');
    }
    const groups = ((info.data?.groups as Array<{ name?: string }> | undefined) ?? []).map(
      (g) => g.name,
    );
    if (!groups.includes(input.project)) {
      throw new UserFacingError(
        403,
        `Your CSC account is not a member of ${input.project}. Check the project in MyCSC.`,
      );
    }

    const base = `/scratch/${input.project}/omicsbase-reports`;
    const images = `${base}/images`;
    const state = `${base}/users/${user}`;
    const sif = `${images}/omicsbase-reports_${c.imageTag}.sif`;
    for (const dir of [images, `${state}/logs`]) {
      const res = await firecrest(input.token, 'POST', '/filesystem/{system}/ops/mkdir', {
        sourcePath: dir,
        parent: true,
      });
      if (res.status >= 300) {
        throw new UserFacingError(
          502,
          `Could not create ${dir} on Roihu. Check that ${input.project} has scratch space.`,
        );
      }
    }
    await firecrest(input.token, 'PUT', '/filesystem/{system}/ops/chmod', {
      sourcePath: state,
      mode: '700',
    });
    const needsImage =
      (
        await firecrest(
          input.token,
          'GET',
          `/filesystem/{system}/ops/stat?path=${encodeURIComponent(sif)}`,
        )
      ).status !== 200;

    const meta: RouteMeta = {
      project: input.project,
      cscUser: user,
      cores: input.cores,
      memory: input.memory,
      hours: input.hours,
      token: await encrypt(input.token),
    };
    const created = await router('POST', '/routes', {
      user: userId,
      hours: Math.min(36, input.hours + (needsImage ? 1 : 0) + 0.25),
      meta,
    });
    if (created.status !== 201) {
      throw new UserFacingError(503, 'No free Reports slot right now. Try again later.');
    }
    const route = created.data as {
      route: string;
      relay_remote: string;
      relay_auth: string;
      session_key: string;
    };

    const submit = async (job: Record<string, unknown>) => {
      const res = await firecrest(input.token, 'POST', '/compute/{system}/jobs', { job });
      const jobId = (res.data?.jobId as string | undefined) ?? undefined;
      if (res.status >= 300 || !jobId) {
        throw new UserFacingError(
          502,
          'Roihu did not accept the job. Check the project and try again.',
        );
      }
      return String(jobId);
    };

    try {
      if (needsImage) {
        meta.prepJobId = await submit({
          name: 'omicsbase-reports-prepare',
          account: input.project,
          partition: 'small',
          workingDirectory: state,
          standardOutput: `${state}/logs/prepare-%j.out`,
          standardError: `${state}/logs/prepare-%j.out`,
          cpusPerTask: 8,
          memoryPerNode: 64 * 1024,
          timeLimit: 60,
          env: { REPORTS_TAG: c.imageTag, REPORTS_IMAGES: images },
          script: readScript(c.scriptsDir, 'pull_image.sbatch'),
        });
      }
      let script = readScript(c.scriptsDir, 'reports.sbatch');
      if (meta.prepJobId) {
        script = script.replace(/^(#!.*\n)/, `$1#SBATCH --dependency=afterok:${meta.prepJobId}\n`);
      }
      meta.jobId = await submit({
        name: 'omicsbase-reports',
        account: input.project,
        partition: 'interactive',
        workingDirectory: state,
        standardOutput: `${state}/logs/reports-%j.out`,
        standardError: `${state}/logs/reports-%j.out`,
        cpusPerTask: input.cores,
        memoryPerNode: input.memory * 1024,
        timeLimit: input.hours * 60,
        env: {
          REPORTS_IMAGE: sif,
          REPORTS_STATE: state,
          SESSION_KEY: route.session_key,
          RELAY_URL: c.relayUrl,
          RELAY_FINGERPRINT: c.relayFingerprint,
          RELAY_REMOTE: route.relay_remote,
          RELAY_AUTH: route.relay_auth,
        },
        script,
      });
      const saved = await router('PUT', `/routes/${route.route}/meta`, { user: userId, meta });
      if (saved.status !== 204) {
        throw new Error(`router answered ${saved.status} when saving the session`);
      }
    } catch (e) {
      for (const id of [meta.jobId, meta.prepJobId]) {
        if (id) {
          await firecrest(input.token, 'DELETE', `/compute/{system}/jobs/${id}`).catch(
            () => undefined,
          );
        }
      }
      await removeRoute(userId, route.route).catch(() => undefined);
      throw e;
    }
    return {
      state: needsImage ? 'preparing' : 'queued',
      project: input.project,
      cores: input.cores,
      memory: input.memory,
      hours: input.hours,
    };
  }

  async function openLink(userId: string): Promise<string> {
    const r = await liveRoute(userId);
    if (!r) {
      throw new UserFacingError(404, 'You have no Reports session on Roihu.');
    }
    const { status, data } = await router('POST', `/routes/${r.route}/link`, { user: userId });
    if (status !== 200 || !data?.url) {
      throw new UserFacingError(404, 'You have no Reports session on Roihu.');
    }
    return data.url as string;
  }

  async function stop(userId: string): Promise<SessionView> {
    const r = await liveRoute(userId);
    if (!r) {
      return { state: 'none' };
    }
    try {
      const token = await decrypt(r.meta.token);
      for (const id of [r.meta.jobId, r.meta.prepJobId]) {
        if (id) {
          await firecrest(token, 'DELETE', `/compute/{system}/jobs/${id}`);
        }
      }
    } catch (e) {
      if (!(e instanceof UserFacingError && e.status === 401)) {
        throw e;
      }
      await removeRoute(userId, r.route);
      return {
        state: 'ended',
        message:
          'Your CSC access token has expired, so the job could not be cancelled from here. It ends at its time limit, or cancel it in the Roihu web interface.',
      };
    }
    await removeRoute(userId, r.route);
    return { state: 'ended', message: 'Your session was stopped.' };
  }

  return { view: view, launch: launch, openLink: openLink, stop: stop };
}

export function createRoihuHandlers(deps: RoihuDeps): RoihuHandlers {
  const client = createRoihuClient(deps);

  const wrap =
    (fn: (userId: string, req: AuthedRequest) => Promise<unknown>): Handler =>
    async (req, res) => {
      const userId = req.user?.id ?? req.user?._id?.toString() ?? '';
      res.setHeader('Cache-Control', 'no-store');
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        return res.json(await fn(userId, req));
      } catch (e) {
        if (e instanceof UserFacingError) {
          return res.status(e.status).json({ error: e.message });
        }
        logger.error('[roihu] request failed', { error: (e as Error).message });
        return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
      }
    };

  return {
    getSession: wrap((userId) => client.view(userId)),
    launchSession: async (req: AuthedRequest, res: Response): Promise<Response> => {
      const { input, errors } = validateLaunch(req.body);
      if (!input) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ error: 'Check the highlighted fields.', fields: errors });
      }
      return wrap((userId) => client.launch(userId, input))(req, res);
    },
    openSession: wrap(async (userId) => ({ url: await client.openLink(userId) })),
    stopSession: wrap((userId) => client.stop(userId)),
  };
}
