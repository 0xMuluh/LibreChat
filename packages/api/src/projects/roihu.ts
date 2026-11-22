import fs from 'fs';
import path from 'path';
import { logger, encryptV2, decryptV2 } from '@librechat/data-schemas';
import type { Request, Response } from 'express';

/**
 * Reports on Roihu: each user's Reports agent runs as their own Slurm job on CSC's Roihu,
 * submitted through FirecREST with the user's CSC access token, and reached through its own
 * route on the OmicsBase relay (deployment/roihu in the omicsbase repo).
 */

/**
 * The router is all a local install needs (it links users' machines); Roihu jobs and
 * machines that dial out to the relay need the rest, which is empty when not set.
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
  /** This OmicsBase's address, which an attached machine connects to. */
  appUrl: string;
}

/** Reads the configuration; null when no router is set up on this deployment. */
export function roihuConfig(env: NodeJS.ProcessEnv = process.env): RoihuConfig | null {
  if (!env.ROIHU_ROUTER_URL || !env.ROIHU_ROUTER_SECRET) {
    return null;
  }
  return {
    routerUrl: env.ROIHU_ROUTER_URL,
    routerSecret: env.ROIHU_ROUTER_SECRET,
    firecrestUrl: env.ROIHU_FIRECREST_URL || 'https://api.roihu.csc.fi/v1',
    system: env.ROIHU_FIRECREST_SYSTEM || 'cpu',
    imageTag: env.ROIHU_IMAGE_TAG || '',
    relayUrl: env.ROIHU_RELAY_URL || '',
    relayFingerprint: env.ROIHU_RELAY_FINGERPRINT || '',
    scriptsDir: env.ROIHU_SCRIPTS_DIR || '',
    appUrl: (env.DOMAIN_CLIENT || '').replace(/\/$/, ''),
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
  | 'unknown'
  /** An attached machine whose tunnel is down (switched off, or its container stopped). */
  | 'offline';

export interface SessionView {
  state: SessionState;
  project?: string;
  cores?: number;
  memory?: number;
  hours?: number;
  endsAt?: number;
  message?: string;
  /** Name of the user's own machine, for an attached session. */
  machine?: string;
  /** When the session was launched, and when its CSC token expires if the token says. */
  launchedAt?: number;
  tokenExpires?: number;
}

/**
 * How to attach a machine here: with the relay, a one-time code and the command that uses it;
 * in a local install, the command that makes the machine print a pairing string to paste.
 */
export interface PairingView {
  command: string;
  code?: string;
  expires?: number;
}

/** What a newly paired machine needs to connect: the relay and its own session key. */
export interface AttachSettings {
  relayUrl: string;
  relayFingerprint: string;
  relayRemote: string;
  relayAuth: string;
  sessionKey: string;
}

/** A machine of the user's own: it dialled out to the relay ("attached"), or a local install
 * dials out to it ("linked"). */
interface AttachedMeta {
  kind: 'attached' | 'linked';
  name: string;
}

interface JobMeta {
  kind?: undefined;
  project: string;
  cscUser: string;
  cores: number;
  memory: number;
  hours: number;
  jobId?: string;
  prepJobId?: string;
  token: string;
  launchedAt?: number;
  tokenExpires?: number;
}

type RouteMeta = JobMeta | AttachedMeta;

interface JobInfo {
  state: string;
  start?: number;
  end?: number;
}

interface RouterRoute {
  route: string;
  /** null for an attached machine, whose route does not expire. */
  expires: number | null;
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

function endedMessage(state: string, hours: number): string {
  if (state === 'TIMEOUT') {
    return `Your session reached its time limit of ${hours} hour${hours === 1 ? '' : 's'}.`;
  }
  if (state === 'CANCELLED') {
    return 'Your session was stopped.';
  }
  return `Your session ended (${state.toLowerCase()}).`;
}

/** A route outlives its job by this much, so the end is still reported. */
const ROUTE_GRACE_SECONDS = 15 * 60;

/** The `exp` claim of a JWT access token, if it is one; the token itself is not kept. */
function tokenExpiry(token: string): number | undefined {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

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
  pair(userId: string): Promise<PairingView>;
  claim(code: string, name: string): Promise<AttachSettings>;
  link(userId: string, pairing: string): Promise<SessionView>;
}

type Handler = (req: AuthedRequest, res: Response) => Promise<Response>;

export interface RoihuHandlers {
  getSession: Handler;
  launchSession: Handler;
  openSession: Handler;
  stopSession: Handler;
  startPairing: Handler;
  /** Public: an attached machine has no OmicsBase login; the one-time code is its credential. */
  claimPairing: Handler;
  linkMachine: Handler;
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

  /** Slurm state of a job and, once it runs, its start and end time (start plus time limit). */
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
        | Array<{
            status?: { state?: string };
            time?: { start?: number | null; end?: number | null };
          }>
        | undefined
    )?.[0];
    if (!job) {
      return null;
    }
    const { start, end } = job.time ?? {};
    return {
      state: slurmState(job.status?.state),
      start: start && start > 0 ? start : undefined,
      end: end && end > 0 ? end : undefined,
    };
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
    if (m.kind === 'attached' || m.kind === 'linked') {
      return { state: r.connected ? 'running' : 'offline', machine: m.name };
    }
    const base = {
      project: m.project,
      cores: m.cores,
      memory: m.memory,
      hours: m.hours,
      launchedAt: m.launchedAt,
      tokenExpires: m.tokenExpires,
    };
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
    // The session job waits on preparation, so it can never start: cancel it and clear the way.
    if (prep && ENDED.has(prep) && prep !== 'COMPLETED') {
      if (m.jobId) {
        await firecrest(token, 'DELETE', `/compute/{system}/jobs/${m.jobId}`);
      }
      await removeRoute(userId, r.route);
      return {
        state: 'ended',
        message: 'Preparing the Reports image failed. Launch again to retry.',
      };
    }
    if (job && ENDED.has(job)) {
      await removeRoute(userId, r.route);
      return { state: 'ended', message: endedMessage(job, m.hours) };
    }
    if (prep === 'PENDING' || prep === 'RUNNING') {
      return { ...base, state: 'preparing' };
    }
    if (job === 'PENDING') {
      return { ...base, state: 'queued' };
    }
    if (job === 'RUNNING') {
      // The route was made before the job queued; from its start it lasts as long as the job.
      const start = jobInfoNow?.start;
      const expires = start && start + m.hours * 3600 + ROUTE_GRACE_SECONDS;
      if (expires && r.expires !== expires) {
        await router('PUT', `/routes/${r.route}/expires`, { user: userId, expires });
      }
      return { ...base, endsAt: jobInfoNow?.end, state: r.connected ? 'running' : 'starting' };
    }
    return { ...base, state: 'unknown' };
  }

  /** The settings `what` needs, or a 503 naming what is missing here. */
  function configFor(what: string, fields: Array<keyof RoihuConfig>): RoihuConfig {
    const c = config();
    if (fields.some((field) => !c[field])) {
      throw new UserFacingError(503, `${what} is not set up on this server.`);
    }
    return c;
  }

  async function launch(userId: string, input: LaunchInput): Promise<SessionView> {
    const c = configFor('Reports on Roihu', [
      'imageTag',
      'scriptsDir',
      'relayUrl',
      'relayFingerprint',
    ]);
    if (await liveRoute(userId)) {
      throw new UserFacingError(409, 'You already have a Reports session. Stop it first.');
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
      launchedAt: Math.floor(Date.now() / 1000),
      tokenExpires: tokenExpiry(input.token),
    };
    // The longest a route may last, so a long queue cannot outlast it; view() shortens it to
    // the job's own end once the job starts.
    const created = await router('POST', '/routes', { user: userId, hours: 36, meta });
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
    if (r.meta.kind === 'attached') {
      await removeRoute(userId, r.route);
      return {
        state: 'ended',
        message: `${r.meta.name} is disconnected and can no longer reach OmicsBase. Remove its container there: docker rm -f omicsbase-reports`,
      };
    }
    if (r.meta.kind === 'linked') {
      await removeRoute(userId, r.route);
      return {
        state: 'ended',
        message: `Disconnected from ${r.meta.name}. Its container keeps running there; remove it with docker rm -f omicsbase-reports.`,
      };
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

  async function pair(userId: string): Promise<PairingView> {
    if (await liveRoute(userId)) {
      throw new UserFacingError(409, 'You already have a Reports session. Stop it first.');
    }
    if (!config().relayUrl) {
      const local = configFor('Using your own computer', ['imageTag']);
      return {
        command: [
          'docker run -d --restart unless-stopped --name omicsbase-reports -p 8443:8443',
          '-v omicsbase-reports:/home/openhands -v omicsbase-projects:/projects',
          `ghcr.io/0xmuluh/omicsbase-reports:${local.imageTag}`,
          'serve --address <name or IP of that computer>',
        ].join(' '),
      };
    }
    const c = configFor('Pairing a computer', [
      'imageTag',
      'relayUrl',
      'relayFingerprint',
      'appUrl',
    ]);
    const { status, data } = await router('POST', '/pairings', { user: userId });
    if (status !== 201 || !data?.code) {
      throw new Error(`router answered ${status} to a pairing request`);
    }
    const code = data.code as string;
    const command = [
      'docker run -d --restart unless-stopped --name omicsbase-reports',
      '-v omicsbase-reports:/home/openhands -v omicsbase-projects:/projects',
      `ghcr.io/0xmuluh/omicsbase-reports:${c.imageTag}`,
      `${c.appUrl} --pair ${code} --name "$(hostname)"`,
    ].join(' ');
    return { code, expires: data.expires as number, command };
  }

  async function claim(code: string, name: string): Promise<AttachSettings> {
    const c = configFor('Pairing a computer', ['relayUrl', 'relayFingerprint']);
    const { status, data } = await router('POST', '/pairings/claim', { code, name });
    if (status === 404) {
      throw new UserFacingError(404, 'This pairing code is unknown, used or expired.');
    }
    if (status === 409) {
      throw new UserFacingError(409, 'This account already has a Reports session running.');
    }
    if (status !== 201 || !data?.session_key) {
      throw new Error(`router answered ${status} to a pairing claim`);
    }
    return {
      relayUrl: c.relayUrl,
      relayFingerprint: c.relayFingerprint,
      relayRemote: data.relay_remote as string,
      relayAuth: data.relay_auth as string,
      sessionKey: data.session_key as string,
    };
  }

  /** A local install dials out to the user's machine, which printed this pairing string. */
  async function link(userId: string, pairing: string): Promise<SessionView> {
    /* With a relay, machines dial out to it; never let a user point this server elsewhere. */
    if (config().relayUrl) {
      throw new UserFacingError(
        404,
        'Pairing strings are for local installs. Use the pairing code instead.',
      );
    }
    if (await liveRoute(userId)) {
      throw new UserFacingError(409, 'You already have a Reports session. Stop it first.');
    }
    const { status } = await router('POST', '/links', { user: userId, pairing });
    if (status === 400) {
      throw new UserFacingError(
        400,
        'That is not a pairing string. Copy the whole line that starts with omicsbase-machine:',
      );
    }
    if (status === 409) {
      throw new UserFacingError(409, 'You already have a Reports session. Stop it first.');
    }
    if (status !== 201) {
      throw new Error(`router answered ${status} to a link request`);
    }
    return view(userId);
  }

  return { view, launch, openLink, stop, pair, claim, link };
}

/** Sends a UserFacingError's own message; anything else is logged and kept generic. */
function sendError(res: Response, e: unknown): Response {
  if (e instanceof UserFacingError) {
    return res.status(e.status).json({ error: e.message });
  }
  logger.error('[roihu] request failed', { error: (e as Error).message });
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
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
        return sendError(res, e);
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
    startPairing: wrap((userId) => client.pair(userId)),
    linkMachine: async (req: AuthedRequest, res: Response): Promise<Response> => {
      const { pairing } = (req.body ?? {}) as { pairing?: unknown };
      if (typeof pairing !== 'string' || !pairing.trim() || pairing.length > 4096) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ error: 'Paste the pairing string your computer printed.' });
      }
      return wrap((userId) => client.link(userId, pairing))(req, res);
    },
    claimPairing: async (req: AuthedRequest, res: Response): Promise<Response> => {
      res.setHeader('Cache-Control', 'no-store');
      const { code, name } = (req.body ?? {}) as { code?: unknown; name?: unknown };
      if (typeof code !== 'string' || !code.trim() || code.length > 32) {
        return res.status(400).json({ error: 'A pairing code is required.' });
      }
      try {
        const machine = typeof name === 'string' ? name.slice(0, 64) : '';
        return res.status(201).json(await client.claim(code, machine));
      } catch (e) {
        return sendError(res, e);
      }
    },
  };
}
