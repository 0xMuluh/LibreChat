import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { logger } from '@librechat/data-schemas';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { NextFunction, Request, Response } from 'express';
import type { FederationIdp, FederationMetadata, FederationMetadataResult } from './metadata';
import type { MetadataJob } from './metadata-worker';
import { getSamlResponseIssuer } from './metadata';

export type ParseMetadata = (xml: string, cert: string) => Promise<FederationMetadataResult>;

const DEFAULT_MAX_HEAP_MB = 2048;

/**
 * Verifies metadata in a child process capped at `maxHeapMb`: checking the signature of an
 * aggregate takes about a minute of CPU and over a gigabyte for eduGAIN, and running out of
 * memory must end only the child. The XML goes to the child through a private temporary file,
 * and the result comes back over IPC. Calls run one at a time, so two federations' refreshes
 * never verify at once. A child that exits without a result, or runs past `timeoutMs`, fails the
 * call with the gist of its error output.
 */
export function parseMetadataInProcess(
  scriptPath: string,
  maxHeapMb: number = DEFAULT_MAX_HEAP_MB,
  timeoutMs: number = 15 * 60 * 1000,
): ParseMetadata {
  const run = async (xml: string, cert: string): Promise<FederationMetadataResult> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'saml-metadata-'));
    const file = path.join(dir, 'metadata.xml');
    try {
      await writeFile(file, xml, { mode: 0o600 });
      return await new Promise((resolve, reject) => {
        const child = fork(scriptPath, [], {
          execArgv: [`--max-old-space-size=${maxHeapMb}`],
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4000);
        });
        let result: FederationMetadataResult | undefined;
        child.once('message', (message) => {
          result = message as FederationMetadataResult;
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          if (result) {
            resolve(result);
          } else {
            const lines = stderr
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean);
            const reason = lines.find((line) => line.startsWith('FATAL ERROR')) ?? lines[0];
            const ended = `Metadata process ended (${signal ?? `exit code ${code}`})`;
            reject(new Error(reason ? `${ended}: ${reason}` : ended));
          }
        });
        const job: MetadataJob = { file, cert };
        child.send(job);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  let queue: Promise<unknown> = Promise.resolve();
  return (xml, cert) => {
    const next = queue.then(() => run(xml, cert));
    queue = next.catch(() => undefined);
    return next;
  };
}

/**
 * The metadata parser of the built package, capped at `maxHeapMb` megabytes (a positive integer;
 * otherwise the default, 2048).
 */
export function createMetadataParser(maxHeapMb?: string | number): ParseMetadata {
  const cap = Number(maxHeapMb);
  return parseMetadataInProcess(
    path.join(path.dirname(require.resolve('@librechat/api')), 'auth/metadata-worker.cjs'),
    Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_HEAP_MB,
  );
}

/** The part of `fetch` the metadata download uses. */
export type FetchMetadata = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FederationOptions {
  url: string;
  cert: string;
  fetch?: FetchMetadata;
  /** Verifies the downloaded XML; defaults to `createMetadataParser()`. */
  parse?: ParseMetadata;
  /**
   * Request the persistent NameID format only from identity providers whose metadata lists it,
   * instead of from all of them (the default).
   */
  listedNameIDFormats?: boolean;
  /**
   * A directory to keep the index of verified metadata in, as shibd keeps metadata backing
   * files, so a restart serves sign-ins at once instead of verifying again. Off when unset.
   */
  cacheDir?: string;
  /** How often verified metadata is refreshed (default 6 h). */
  refreshMs?: number;
  /** How soon a failed download is retried (default 10 min). */
  retryMs?: number;
  timeoutMs?: number;
}

export interface Federation {
  /** An identity provider from the current, unexpired metadata. */
  idp(entityID: string): FederationIdp | undefined;
  /** Downloads and verifies the metadata, keeping the last good copy when that fails. */
  refresh(): Promise<boolean>;
  /** Loads the metadata, then keeps refreshing it; resolves once the first load is done. */
  start(): Promise<void>;
  stop(): void;
}

/** The index of verified metadata as it is kept on disk. */
interface CachedMetadata {
  url: string;
  fetchedAt: number;
  validUntil: string;
  idps: FederationIdp[];
}

/**
 * Federation metadata held in memory and refreshed in the background. With `cacheDir`, each
 * verified index is also written there and read back at start: a cache for the same URL whose
 * validUntil is ahead serves sign-ins at once, and the first refresh waits for its normal time
 * (at least `retryMs`). The cache only ever holds `parse`'s verified result; its integrity then
 * rests on the container's file system, as with shibd's backing files.
 */
export function createFederation({
  url,
  cert,
  fetch: request = fetch,
  parse = createMetadataParser(),
  listedNameIDFormats = false,
  cacheDir,
  refreshMs = 6 * 60 * 60 * 1000,
  retryMs = 10 * 60 * 1000,
  timeoutMs = 60 * 1000,
}: FederationOptions): Federation {
  const file = cacheDir
    ? path.join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.json`)
    : undefined;
  let metadata: FederationMetadata | undefined;
  let timer: NodeJS.Timeout | undefined;

  function accept(value: FederationMetadata) {
    metadata = listedNameIDFormats
      ? value
      : {
          ...value,
          idps: new Map(
            [...value.idps].map(([id, idp]): [string, FederationIdp] => [
              id,
              idp.persistent ? idp : { ...idp, persistent: true },
            ]),
          ),
        };
  }

  async function save(value: FederationMetadata, fetchedAt: number) {
    if (!file) {
      return;
    }
    const cached: CachedMetadata = {
      url,
      fetchedAt,
      validUntil: value.validUntil.toISOString(),
      idps: [...value.idps.values()],
    };
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temporary, JSON.stringify(cached), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      logger.warn('[samlFederation] Could not save the metadata cache', error);
    }
  }

  async function load(): Promise<{ value: FederationMetadata; fetchedAt: number } | undefined> {
    if (!file) {
      return undefined;
    }
    try {
      const cached: CachedMetadata = JSON.parse(await readFile(file, 'utf8'));
      const validUntil = new Date(cached.validUntil);
      if (cached.url !== url || !Array.isArray(cached.idps) || !(validUntil > new Date())) {
        return undefined;
      }
      const idps = new Map(cached.idps.map((idp): [string, FederationIdp] => [idp.entityID, idp]));
      return { value: { validUntil, idps }, fetchedAt: Number(cached.fetchedAt) || 0 };
    } catch {
      return undefined;
    }
  }

  async function refresh(): Promise<boolean> {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        logger.warn(`[samlFederation] Metadata download failed with HTTP ${response.status}`);
        return false;
      }
      const fetchedAt = Date.now();
      const result = await parse(await response.text(), cert);
      if (!result.ok) {
        logger.error(`[samlFederation] Metadata rejected (${result.error.code})`);
        return false;
      }
      accept(result.value);
      logger.info(`[samlFederation] Loaded ${result.value.idps.size} identity providers`);
      await save(result.value, fetchedAt);
      return true;
    } catch (error) {
      logger.warn('[samlFederation] Metadata refresh failed', error);
      return false;
    }
  }

  function schedule(ms: number) {
    timer = setTimeout(tick, ms);
    timer.unref();
  }

  async function tick() {
    schedule((await refresh()) ? refreshMs : retryMs);
  }

  return {
    idp(entityID) {
      if (!metadata || metadata.validUntil <= new Date()) {
        return undefined;
      }
      return metadata.idps.get(entityID);
    },
    refresh,
    async start() {
      const cached = await load();
      if (!cached) {
        return tick();
      }
      accept(cached.value);
      logger.info(
        `[samlFederation] Loaded ${cached.value.idps.size} identity providers from cache`,
      );
      schedule(Math.max(cached.fetchedAt + refreshMs - Date.now(), retryMs));
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

/**
 * Several federations' metadata as one, looked up in order: an identity provider both list (a
 * Haka provider also exported to eduGAIN) resolves to the first one's copy, under the same
 * entityID. First loads run one after another, so their workers do not overlap.
 */
export function combineFederations(federations: Federation[]): Federation {
  return {
    idp(entityID) {
      for (const federation of federations) {
        const idp = federation.idp(entityID);
        if (idp) {
          return idp;
        }
      }
      return undefined;
    },
    async refresh() {
      let ok = true;
      for (const federation of federations) {
        ok = (await federation.refresh()) && ok;
      }
      return ok;
    },
    async start() {
      for (const federation of federations) {
        await federation.start();
      }
    },
    stop() {
      federations.forEach((federation) => federation.stop());
    },
  };
}

export type SamlFederationRequest = Request & { samlIdp?: FederationIdp };

/**
 * Chooses the identity provider of a federated SAML request. A sign-in takes `?idp=` or the
 * discovery service's `?entityID=` and without either goes to discovery (the eduGAIN one with
 * `?discovery=edugain`, when configured); a callback takes the
 * Issuer of its response. Identity providers missing from the verified metadata are refused.
 */
export function createSamlFederationGuard({
  federation,
  discoveryUrl,
  edugainDiscoveryUrl,
  entityID,
  returnUrl,
  failureRedirect,
}: {
  federation: Federation;
  discoveryUrl: string;
  /** The discovery service a sign-in with `?discovery=edugain` goes to instead. */
  edugainDiscoveryUrl?: string;
  /** Our SP entityID. */
  entityID: string;
  returnUrl: string;
  failureRedirect: string;
}): (req: SamlFederationRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const response = req.body?.SAMLResponse;
    const chosen =
      typeof response === 'string'
        ? getSamlResponseIssuer(response)
        : [req.query.idp, req.query.entityID].find((value) => typeof value === 'string');

    if (chosen == null && req.method === 'GET') {
      const service =
        req.query.discovery === 'edugain' && edugainDiscoveryUrl
          ? edugainDiscoveryUrl
          : discoveryUrl;
      const query = new URLSearchParams({ entityID, return: returnUrl, returnIDParam: 'entityID' });
      return res.redirect(`${service}${service.includes('?') ? '&' : '?'}${query}`);
    }

    const idp = typeof chosen === 'string' ? federation.idp(chosen) : undefined;
    if (!idp) {
      logger.warn('[samlFederation] Refused an identity provider missing from the metadata');
      return res.redirect(failureRedirect);
    }
    req.samlIdp = idp;
    next();
  };
}

/**
 * SAML options for the identity provider the guard chose, for MultiSamlStrategy. Federation
 * identity providers sign either the response or the assertion, so either is accepted; one
 * of them must still verify against the provider's certificates. Given the home identity
 * provider, any other provider whose metadata does not list the persistent NameID format is not
 * asked for one: a provider that cannot meet the requested format must answer with an error, and
 * such logins are keyed on their subject identifier attributes instead.
 */
export function getFederationSamlOptions(
  req: SamlFederationRequest,
  done: (error: Error | null, options?: Record<string, unknown>) => void,
  homeIssuer?: string,
): void {
  const idp = req.samlIdp;
  if (!idp) {
    return done(new Error('No SAML identity provider chosen'));
  }
  done(null, {
    entryPoint: idp.entryPoint,
    idpCert: idp.certs,
    wantAssertionsSigned: false,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
    ...(homeIssuer && idp.entityID !== homeIssuer && !idp.persistent
      ? { identifierFormat: null }
      : {}),
  });
}
