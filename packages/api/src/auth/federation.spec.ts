import path from 'node:path';
import type { Response } from 'express';
import type { FederationIdp, FederationMetadataResult } from './metadata';
import type { Federation, SamlFederationRequest } from './federation';
import {
  createFederation,
  parseMetadataInWorker,
  getFederationSamlOptions,
  createSamlFederationGuard,
} from './federation';
import { UTU_IDP, makeSigner, metadataXml, signMetadata } from './__fixtures__/metadata';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const idp: FederationIdp = {
  entityID: UTU_IDP,
  entryPoint: 'https://idp.utu.example/redirect',
  certs: ['U0lHTklORw=='],
  scopes: ['utu.fi'],
};

const loaded = (validUntil = new Date('2099-01-01')): FederationMetadataResult => ({
  ok: true,
  value: { validUntil, idps: new Map([[idp.entityID, idp]]) },
});

const reply = (body = '<xml/>', ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  text: async () => body,
});

describe('createFederation', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('keeps the last good metadata when a refresh fails', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(reply())
      .mockResolvedValueOnce(reply('', false))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(reply());
    const parse = jest
      .fn()
      .mockResolvedValueOnce(loaded())
      .mockResolvedValueOnce({ ok: false, error: { code: 'bad_signature', message: 'no' } });
    const federation = createFederation({
      url: 'https://fed.example/md.xml',
      cert: 'C',
      fetch,
      parse,
    });

    expect(federation.idp(UTU_IDP)).toBeUndefined();
    expect(await federation.refresh()).toBe(true);
    expect(fetch).toHaveBeenCalledWith('https://fed.example/md.xml', expect.anything());
    expect(parse).toHaveBeenCalledWith('<xml/>', 'C');

    for (let failure = 0; failure < 3; failure++) {
      expect(await federation.refresh()).toBe(false);
      expect(federation.idp(UTU_IDP)).toBe(idp);
    }
    expect(federation.idp('https://unknown.example/idp')).toBeUndefined();
  });

  test('serves nothing from metadata past its validUntil', async () => {
    const fetch = jest.fn().mockResolvedValue(reply());
    const parse = jest.fn().mockResolvedValue(loaded(new Date(Date.now() - 1000)));
    const federation = createFederation({ url: 'u', cert: 'C', fetch, parse });

    await federation.refresh();

    expect(federation.idp(UTU_IDP)).toBeUndefined();
  });

  test('retries a failed download sooner than the regular refresh', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(reply());
    const parse = jest.fn().mockResolvedValue(loaded());
    const federation = createFederation({
      url: 'u',
      cert: 'C',
      fetch,
      parse,
      refreshMs: 1000,
      retryMs: 100,
    });

    federation.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledTimes(3);
    federation.stop();
  });
});

describe('parseMetadataInWorker', () => {
  test('verifies metadata on a worker thread', async () => {
    const workerPath = path.join(
      path.dirname(require.resolve('@librechat/api')),
      'auth/metadata-worker.cjs',
    );
    const signer = makeSigner();
    const xml = signMetadata(metadataXml(), signer.privateKey);

    const result = await parseMetadataInWorker(workerPath)(xml, signer.cert);

    expect(result.ok && result.value.idps.get(UTU_IDP)?.scopes).toEqual([
      'utu.fi',
      'turku.example',
    ]);
  });
});

describe('createSamlFederationGuard', () => {
  const federation: Federation = {
    idp: (entityID) => (entityID === idp.entityID ? idp : undefined),
    refresh: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  };
  const options = {
    federation,
    discoveryUrl: 'https://wayf.example/WAYF',
    entityID: 'https://omicsbase.example',
    returnUrl: 'https://omicsbase.example/oauth/saml',
    failureRedirect: 'https://omicsbase.example/oauth/error',
  };

  function run(request: Partial<SamlFederationRequest>, guardOptions = options) {
    const req = { method: 'GET', query: {}, ...request } as SamlFederationRequest;
    const res = { redirect: jest.fn() } as unknown as Response;
    const next = jest.fn();
    createSamlFederationGuard(guardOptions)(req, res, next);
    return { req, redirect: res.redirect as jest.Mock, next };
  }

  const response = (issuer: string) =>
    Buffer.from(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:Response>`,
    ).toString('base64');

  test('sends a sign-in without an identity provider to discovery', () => {
    const { redirect, next } = run({});

    expect(redirect).toHaveBeenCalledWith(
      'https://wayf.example/WAYF?entityID=https%3A%2F%2Fomicsbase.example' +
        '&return=https%3A%2F%2Fomicsbase.example%2Foauth%2Fsaml&returnIDParam=entityID',
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('extends a discovery URL that already has a query', () => {
    const { redirect } = run({}, { ...options, discoveryUrl: 'https://ds.example/ds/?lang=fi' });
    expect(redirect.mock.calls[0][0]).toMatch(/^https:\/\/ds\.example\/ds\/\?lang=fi&entityID=/);
  });

  test.each([{ idp: UTU_IDP }, { entityID: UTU_IDP }])('starts a sign-in with %p', (query) => {
    const { req, redirect, next } = run({ query });

    expect(next).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(req.samlIdp).toBe(idp);
  });

  test('accepts a callback from a known identity provider', () => {
    const { req, next } = run({ method: 'POST', body: { SAMLResponse: response(UTU_IDP) } });

    expect(next).toHaveBeenCalled();
    expect(req.samlIdp).toBe(idp);
  });

  test.each<[string, Partial<SamlFederationRequest>]>([
    ['a sign-in with an unknown identity provider', { query: { idp: 'https://evil.example' } }],
    [
      'a callback from an unknown identity provider',
      { method: 'POST', body: { SAMLResponse: response('https://evil.example') } },
    ],
    ['a callback without a response', { method: 'POST', body: {} }],
  ])('refuses %s', (_label, request) => {
    const { req, redirect, next } = run(request);

    expect(redirect).toHaveBeenCalledWith(options.failureRedirect);
    expect(next).not.toHaveBeenCalled();
    expect(req.samlIdp).toBeUndefined();
  });
});

describe('getFederationSamlOptions', () => {
  test("uses the chosen identity provider's entry point and certificates", () => {
    const done = jest.fn();
    getFederationSamlOptions({ samlIdp: idp } as SamlFederationRequest, done);

    expect(done).toHaveBeenCalledWith(null, {
      entryPoint: idp.entryPoint,
      idpCert: idp.certs,
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: false,
      disableRequestedAuthnContext: true,
    });
  });

  test('fails without a chosen identity provider', () => {
    const done = jest.fn();
    getFederationSamlOptions({} as SamlFederationRequest, done);
    expect(done).toHaveBeenCalledWith(expect.any(Error));
  });
});
