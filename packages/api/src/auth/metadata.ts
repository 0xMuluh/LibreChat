import { SignedXml } from 'xml-crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const MD = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const SHIBMD = 'urn:mace:shibboleth:metadata:1.0';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

/** An identity provider from verified federation metadata. */
export interface FederationIdp {
  entityID: string;
  /** Its SingleSignOnService for the HTTP-Redirect binding. */
  entryPoint: string;
  /** Its signing certificates (base64 DER). */
  certs: string[];
  /** The domains its `shibmd:Scope` elements list, lower-case; regexp scopes are left out. */
  scopes: string[];
  /** Whether to request the persistent NameID format from it: whether its metadata lists it. */
  persistent: boolean;
}

export interface FederationMetadata {
  validUntil: Date;
  idps: Map<string, FederationIdp>;
}

export type FederationMetadataError = 'invalid_xml' | 'unsigned' | 'bad_signature' | 'expired';

export type FederationMetadataResult =
  | { ok: true; value: FederationMetadata }
  | { ok: false; error: { code: FederationMetadataError; message: string } };

type Failure = Extract<FederationMetadataResult, { ok: false }>;

function fail(code: FederationMetadataError, message: string): Failure {
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

/**
 * An identity provider's sign-in settings. Account keys start with `<entityID>!`, so an entityID
 * containing `!` is left out to keep them unambiguous; no Haka or eduGAIN entity has one.
 */
function readIdp(entity: Element): FederationIdp | undefined {
  const entityID = entity.getAttribute('entityID')?.trim();
  const descriptor = children(entity, MD, 'IDPSSODescriptor').find((idp) =>
    (idp.getAttribute('protocolSupportEnumeration') ?? '').split(/\s+/).includes(PROTOCOL),
  );
  if (!entityID || entityID.includes('!') || !descriptor) {
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
  const persistent = children(descriptor, MD, 'NameIDFormat').some(
    (format) => text(format) === PERSISTENT,
  );
  return { entityID, entryPoint, certs, scopes, persistent };
}

type Stage<T> = { ok: true; value: T } | Failure;

/**
 * The root element's name and its one signature, serialised, so the parsed document can be
 * freed before the signature check parses the XML again.
 */
function locateSignature(xml: string): Stage<{ root: string; signature: string }> {
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
  const signature = new XMLSerializer().serializeToString(signatures[0]);
  return { ok: true, value: { root: root.localName, signature } };
}

/** The canonical content the signature covers, once it verifies against `cert`. */
function verifySignature(xml: string, signature: string, cert: string): Stage<string> {
  const signed = new SignedXml({ publicCert: toPem(cert), getCertFromKeyInfo: () => null });
  let references: string[] = [];
  try {
    signed.loadSignature(signature);
    references = signed.checkSignature(xml) ? signed.getSignedReferences() : [];
  } catch (error) {
    return fail('bad_signature', (error as Error).message);
  }
  if (references.length !== 1) {
    return fail('bad_signature', 'Metadata signature does not verify');
  }
  return { ok: true, value: references[0] };
}

/**
 * Verifies a federation metadata aggregate against the federation's signing certificate and
 * indexes its SAML 2.0 identity providers by entityID. Only the signed content is read, so
 * elements outside the signature cannot inject identity providers. Each stage's parsed document
 * is released before the next is built, which keeps the peak memory of a large aggregate to
 * about one document.
 */
export function parseFederationMetadata(
  xml: string,
  cert: string,
  now: Date = new Date(),
): FederationMetadataResult {
  const located = locateSignature(xml);
  if (!located.ok) {
    return located;
  }
  const verified = verifySignature(xml, located.value.signature, cert);
  if (!verified.ok) {
    return verified;
  }

  const content = parseXml(verified.value).documentElement;
  if (!content || content.namespaceURI !== MD || content.localName !== located.value.root) {
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
