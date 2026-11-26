import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SHIBMD = 'urn:mace:shibboleth:metadata:1.0';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/** An identity provider from verified federation metadata. */
export interface FederationIdp {
  entityID: string;
  /** Its SingleSignOnService for the HTTP-Redirect binding. */
  entryPoint: string;
  /** Its signing certificates (base64 DER). */
  certs: string[];
  /** The domains its `shibmd:Scope` elements list, lower-case; regexp scopes are left out. */
  scopes: string[];
}

export interface FederationMetadata {
  validUntil: Date;
  idps: Map<string, FederationIdp>;
}

export type FederationMetadataError = 'invalid_xml' | 'unsigned' | 'bad_signature' | 'expired';

export type FederationMetadataResult =
  | { ok: true; value: FederationMetadata }
  | { ok: false; error: { code: FederationMetadataError; message: string } };

function fail(code: FederationMetadataError, message: string): FederationMetadataResult {
  return { ok: false, error: { code, message } };
}

/** A certificate as PEM; a bare base64 body gets its header and footer. */
function toPem(cert: string): string {
  if (cert.includes('-----BEGIN')) {
    return cert;
  }
  const body =
    cert
      .replace(/\s+/g, '')
      .match(/.{1,64}/g)
      ?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function parseXml(xml: string): Document {
  const raise = (msg: unknown) => {
    throw new Error(String(msg));
  };
  return new DOMParser({ errorHandler: { error: raise, fatalError: raise } }).parseFromString(
    xml,
    'text/xml',
  );
}

function children(parent: Element, ns: string, name: string): Element[] {
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const element = node as Element;
    if (node.nodeType === 1 && element.namespaceURI === ns && element.localName === name) {
      found.push(element);
    }
  }
  return found;
}

function text(element: Element): string {
  return (element.textContent ?? '').trim();
}

function scopesOf(parent: Element): string[] {
  return children(parent, MD, 'Extensions')
    .flatMap((extensions) => children(extensions, SHIBMD, 'Scope'))
    .filter((scope) => !['true', '1'].includes(scope.getAttribute('regexp') ?? ''))
    .map((scope) => text(scope).toLowerCase())
    .filter(Boolean);
}

function readIdp(entity: Element): FederationIdp | undefined {
  const entityID = entity.getAttribute('entityID')?.trim();
  const descriptor = children(entity, MD, 'IDPSSODescriptor').find((idp) =>
    (idp.getAttribute('protocolSupportEnumeration') ?? '').split(/\s+/).includes(PROTOCOL),
  );
  if (!entityID || !descriptor) {
    return undefined;
  }

  const entryPoint = children(descriptor, MD, 'SingleSignOnService')
    .find((service) => service.getAttribute('Binding') === REDIRECT)
    ?.getAttribute('Location')
    ?.trim();
  const certs = children(descriptor, MD, 'KeyDescriptor')
    .filter((key) => (key.getAttribute('use') || 'signing') === 'signing')
    .flatMap((key) => Array.from(key.getElementsByTagNameNS(DS, 'X509Certificate')))
    .map((cert) => text(cert).replace(/\s+/g, ''))
    .filter(Boolean);
  if (!entryPoint || certs.length === 0) {
    return undefined;
  }

  const scopes = [...new Set([...scopesOf(descriptor), ...scopesOf(entity)])];
  return { entityID, entryPoint, certs, scopes };
}

/**
 * Verifies a federation metadata aggregate against the federation's signing certificate and
 * indexes its SAML 2.0 identity providers by entityID. Only the signed content is read, so
 * elements outside the signature cannot inject identity providers.
 */
export function parseFederationMetadata(
  xml: string,
  cert: string,
  now: Date = new Date(),
): FederationMetadataResult {
  let root: Element | null;
  try {
    root = parseXml(xml).documentElement;
  } catch (error) {
    return fail('invalid_xml', (error as Error).message);
  }
  if (!root || root.namespaceURI !== MD) {
    return fail('invalid_xml', 'Not SAML metadata');
  }

  const signatures = children(root, DS, 'Signature');
  if (signatures.length !== 1) {
    return fail('unsigned', 'Metadata must carry exactly one signature on its root element');
  }

  const signed = new SignedXml({ publicCert: toPem(cert), getCertFromKeyInfo: () => null });
  let references: string[] = [];
  try {
    signed.loadSignature(signatures[0]);
    references = signed.checkSignature(xml) ? signed.getSignedReferences() : [];
  } catch (error) {
    return fail('bad_signature', (error as Error).message);
  }
  if (references.length !== 1) {
    return fail('bad_signature', 'Metadata signature does not verify');
  }

  const content = parseXml(references[0]).documentElement;
  if (!content || content.namespaceURI !== MD || content.localName !== root.localName) {
    return fail('bad_signature', 'Metadata signature does not cover the root element');
  }

  const validUntil = new Date(content.getAttribute('validUntil') ?? '');
  if (Number.isNaN(validUntil.getTime()) || validUntil <= now) {
    return fail('expired', 'Metadata has no future validUntil');
  }

  const entities =
    content.localName === 'EntityDescriptor'
      ? [content]
      : Array.from(content.getElementsByTagNameNS(MD, 'EntityDescriptor'));
  const idps = new Map<string, FederationIdp>();
  for (const entity of entities) {
    const idp = readIdp(entity);
    if (idp) {
      idps.set(idp.entityID, idp);
    }
  }
  return { ok: true, value: { validUntil, idps } };
}

/** The Issuer of a base64 SAML Response, or of its plaintext assertion. Unverified. */
export function getSamlResponseIssuer(response: string): string | undefined {
  try {
    const root = parseXml(Buffer.from(response, 'base64').toString('utf8')).documentElement;
    if (!root || root.namespaceURI !== PROTOCOL || root.localName !== 'Response') {
      return undefined;
    }
    const issuer =
      children(root, ASSERTION, 'Issuer')[0] ??
      children(root, ASSERTION, 'Assertion').flatMap((a) => children(a, ASSERTION, 'Issuer'))[0];
    return issuer ? text(issuer) || undefined : undefined;
  } catch {
    return undefined;
  }
}
