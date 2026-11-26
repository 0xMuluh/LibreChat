import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { FederationIdp, FederationMetadata, FederationMetadataResult } from './metadata';
import type { MetadataJob } from './metadata-worker';
import { getSamlResponseIssuer } from './metadata';

export type ParseMetadata = (xml: string, cert: string) => Promise<FederationMetadataResult>;

/**
 * Verifies metadata on a one-off worker thread with a capped heap: checking the signature of an
 * aggregate takes seconds of CPU, and a large one must not exhaust the server's memory.
 */
export function parseMetadataInWorker(workerPath: string, maxHeapMb = 1024): ParseMetadata {
  return (xml, cert) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
      });
      worker.once('message', (result: FederationMetadataResult) => {
        resolve(result);
        void worker.terminate();
      });
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`Metadata worker exited with code ${code}`)));
      const job: MetadataJob = { xml, cert };
      worker.postMessage(job);
    });
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
  /** Verifies the downloaded XML; defaults to a worker thread. */
  parse?: ParseMetadata;
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
  start(): void;
  stop(): void;
}

/** Federation metadata held in memory and refreshed in the background. */
export function createFederation({
  url,
  cert,
  fetch: request = fetch,
  parse = parseMetadataInWorker(
    path.join(path.dirname(require.resolve('@librechat/api')), 'auth/metadata-worker.cjs'),
  ),
  refreshMs = 6 * 60 * 60 * 1000,
  retryMs = 10 * 60 * 1000,
  timeoutMs = 60 * 1000,
}: FederationOptions): Federation {
  let metadata: FederationMetadata | undefined;
  let timer: NodeJS.Timeout | undefined;

  async function refresh(): Promise<boolean> {
    try {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        logger.warn(`[samlFederation] Metadata download failed with HTTP ${response.status}`);
        return false;
      }
      const result = await parse(await response.text(), cert);
      if (!result.ok) {
        logger.error(`[samlFederation] Metadata rejected (${result.error.code})`);
        return false;
      }
      metadata = result.value;
      logger.info(`[samlFederation] Loaded ${metadata.idps.size} identity providers`);
      return true;
    } catch (error) {
      logger.warn('[samlFederation] Metadata refresh failed', error);
      return false;
    }
  }

  async function tick() {
    const ok = await refresh();
    timer = setTimeout(tick, ok ? refreshMs : retryMs);
    timer.unref();
  }

  return {
    idp(entityID) {
      if (!metadata || metadata.validUntil <= new Date()) {
        return undefined;
      }
      return metadata.idps.get(entityID);
    },
    refresh,
    start() {
      void tick();
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

export type SamlFederationRequest = Request & { samlIdp?: FederationIdp };

/**
 * Chooses the identity provider of a federated SAML request. A sign-in takes `?idp=` or the
 * discovery service's `?entityID=` and without either goes to discovery; a callback takes the
 * Issuer of its response. Identity providers missing from the verified metadata are refused.
 */
export function createSamlFederationGuard({
  federation,
  discoveryUrl,
  entityID,
  returnUrl,
  failureRedirect,
}: {
  federation: Federation;
  discoveryUrl: string;
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
      const query = new URLSearchParams({ entityID, return: returnUrl, returnIDParam: 'entityID' });
      return res.redirect(`${discoveryUrl}${discoveryUrl.includes('?') ? '&' : '?'}${query}`);
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
 * of them must still verify against the provider's certificates.
 */
export function getFederationSamlOptions(
  req: SamlFederationRequest,
  done: (error: Error | null, options?: Record<string, unknown>) => void,
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
  });
}
