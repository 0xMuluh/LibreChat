import { logger } from '@librechat/data-schemas';
import { ErrorTypes } from 'librechat-data-provider';
import type { AppConfig, UserRecord } from '@librechat/data-schemas';
import type {
  GetAppConfig,
  GetBalanceConfig,
  ProvisionedUser,
  FindUserByFields,
  FindBalanceByUser,
  CreateUserIfAbsent,
  LoginUserResolution,
} from './provision';
import { createUserOnce } from './provision';

export const TRANSIENT_SAML_NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

export type SamlSubjectError = 'missing_name_id' | 'transient_name_id' | 'issuer_mismatch';

export interface SamlSubjectProfile {
  nameID?: string;
  nameIDFormat?: string;
  issuer?: string;
}

export type SamlSubjectResolution =
  | { nameID: string; error?: never }
  | { nameID?: never; error: SamlSubjectError };

export function resolveSamlSubject(
  profile: SamlSubjectProfile | null | undefined,
  expectedIssuer?: string,
): SamlSubjectResolution {
  const nameID = profile?.nameID;
  if (typeof nameID !== 'string' || nameID.trim().length === 0) {
    return { error: 'missing_name_id' };
  }

  if (profile?.nameIDFormat === TRANSIENT_SAML_NAME_ID_FORMAT) {
    return { error: 'transient_name_id' };
  }

  const normalizedExpectedIssuer = expectedIssuer?.trim();
  const issuer = typeof profile?.issuer === 'string' ? profile.issuer.trim() : '';
  if (normalizedExpectedIssuer && issuer !== normalizedExpectedIssuer) {
    return { error: 'issuer_mismatch' };
  }

  return { nameID };
}

const EPPN_CLAIMS = ['eduPersonPrincipalName', 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6'];
const SCHAC_HOME_ORGANIZATION_CLAIMS = ['schacHomeOrganization', 'urn:oid:1.3.6.1.4.1.25178.1.2.9'];

function getClaim(profile: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const raw = profile[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function domainOf(value: string | undefined): string | undefined {
  if (!value?.includes('@')) {
    return undefined;
  }
  return value.split('@').pop()?.trim().toLowerCase() || undefined;
}

/** Whether `domain` is one of `scopes` or a subdomain of one; a bare top-level scope has none. */
function inScope(domain: string, scopes: string[]): boolean {
  return scopes.some(
    (scope) => domain === scope || (scope.includes('.') && domain.endsWith(`.${scope}`)),
  );
}

/**
 * The home organisation's domain of a SAML login: the scope of eduPersonPrincipalName, else
 * schacHomeOrganization, else the domain of `email`. With `scopes` (the issuing identity
 * provider's `shibmd:Scope` list from federation metadata), a domain that is neither one of
 * them nor a subdomain of one is skipped, so one identity provider cannot claim another's
 * organisation.
 */
export function getSamlHomeOrganization(
  profile: Record<string, unknown>,
  email?: string,
  scopes?: string[],
): string | undefined {
  const candidates = [
    domainOf(getClaim(profile, EPPN_CLAIMS)),
    getClaim(profile, SCHAC_HOME_ORGANIZATION_CLAIMS)?.toLowerCase(),
    domainOf(email),
  ];
  return candidates.find((domain) => domain && (!scopes || inScope(domain, scopes)));
}

/**
 * The role an account created at its first SAML sign-in gets. With `orgRoles` (comma-separated
 * `domain:role` pairs), the role of the most specific domain that equals or is a parent of the
 * login's home organisation; otherwise, or when none matches, `defaultRole` (USER when unset).
 */
export function resolveSamlRole({
  profile,
  email,
  scopes,
  orgRoles,
  defaultRole,
}: {
  profile: Record<string, unknown>;
  email?: string;
  scopes?: string[];
  orgRoles?: string;
  defaultRole?: string;
}): string | undefined {
  const fallback = defaultRole?.trim() || undefined;
  const pairs = orgRoles?.trim();
  const organization = pairs ? getSamlHomeOrganization(profile, email, scopes) : undefined;
  if (!pairs || !organization) {
    return fallback;
  }

  let match: { domain: string; role: string } | undefined;
  for (const pair of pairs.split(',')) {
    const [domain, role] = pair.split(':').map((part) => part.trim());
    const key = domain?.toLowerCase();
    if (!key || !role || (organization !== key && !organization.endsWith(`.${key}`))) {
      continue;
    }
    if (!match || key.length > match.domain.length) {
      match = { domain: key, role };
    }
  }
  return match?.role ?? fallback;
}

const PAIRWISE_ID_CLAIMS = ['urn:oasis:names:tc:SAML:attribute:pairwise-id', 'pairwise-id'];
const SUBJECT_ID_CLAIMS = ['urn:oasis:names:tc:SAML:attribute:subject-id', 'subject-id'];
/** The value syntax of pairwise-id and subject-id (OASIS SAML V2.0 Subject Identifier Attributes 3.3.1). */
const SUBJECT_ID_SYNTAX = /^[A-Za-z0-9][A-Za-z0-9=-]{0,126}@[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/;
const EPPN_SYNTAX = /^[^@\s]+@[^@\s]+$/;

/**
 * A scoped identifier attribute (`value@scope`) in lower case, if it has exactly one value, the
 * value matches `syntax`, and its scope is one the identity provider's metadata allows.
 */
function getScopedIdentifier(
  profile: Record<string, unknown>,
  names: string[],
  syntax: RegExp,
  scopes: string[],
): string | undefined {
  const raw = names.map((name) => profile[name]).find((value) => value != null);
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : undefined;
  if (!value || !syntax.test(value)) {
    return undefined;
  }
  return inScope(value.slice(value.indexOf('@') + 1), scopes) ? value : undefined;
}

export type FederatedSamlSubjectError = SamlSubjectError | 'email_out_of_scope' | 'no_identifier';

export type FederatedSamlSubject =
  | { samlId: string; error?: never }
  | { samlId?: never; error: FederatedSamlSubjectError };

/**
 * The SAML identity a login through federation metadata is stored under.
 *
 * The home identity provider (`homeIssuer`) keeps the plain, non-transient NameID, so its
 * accounts continue unchanged. Any other provider's login must come from that provider and carry
 * an email in one of its metadata scopes or their subdomains, so it can neither reach nor claim an
 * address in another organisation's domain. Its account key is the first of:
 *
 * - `<entityID>!<NameID>` for a NameID that is not transient (the key from before);
 * - `<entityID>!pairwise:<pairwise-id>`;
 * - `<entityID>!subject:<subject-id>`;
 * - `<entityID>!eppn:<eduPersonPrincipalName>`.
 *
 * Every scoped value must be in the provider's scopes, and pairwise-id and subject-id must follow
 * their specification's syntax; the scoped values are compared in lower case, as both
 * specifications require. A NameID that begins with one of the prefixes is not used, so keys of
 * different kinds never collide. eduPersonPrincipalName comes last because some federations allow
 * reassigning it to another person after a retention period, while the others are never
 * reassigned.
 */
export function resolveFederatedSamlSubject({
  profile,
  email,
  idp,
  homeIssuer,
}: {
  profile: Record<string, unknown>;
  email: string;
  idp: { entityID: string; scopes: string[] };
  homeIssuer: string;
}): FederatedSamlSubject {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const nameID = text(profile.nameID);
  const nameIDFormat = text(profile.nameIDFormat);
  const issuer = text(profile.issuer);
  if (idp.entityID === homeIssuer) {
    const subject = resolveSamlSubject({ nameID, nameIDFormat, issuer }, idp.entityID);
    return subject.error ? { error: subject.error } : { samlId: subject.nameID };
  }
  if (issuer?.trim() !== idp.entityID) {
    return { error: 'issuer_mismatch' };
  }
  const domain = domainOf(email);
  if (!domain || !inScope(domain, idp.scopes)) {
    return { error: 'email_out_of_scope' };
  }

  const identifiers: [string, string | undefined][] = [
    ['pairwise', getScopedIdentifier(profile, PAIRWISE_ID_CLAIMS, SUBJECT_ID_SYNTAX, idp.scopes)],
    ['subject', getScopedIdentifier(profile, SUBJECT_ID_CLAIMS, SUBJECT_ID_SYNTAX, idp.scopes)],
    ['eppn', getScopedIdentifier(profile, EPPN_CLAIMS, EPPN_SYNTAX, idp.scopes)],
  ];
  if (
    nameID?.trim() &&
    nameIDFormat !== TRANSIENT_SAML_NAME_ID_FORMAT &&
    !identifiers.some(([kind]) => nameID.startsWith(`${kind}:`))
  ) {
    return { samlId: `${idp.entityID}!${nameID}` };
  }
  const found = identifiers.find(([, value]) => value);
  return found ? { samlId: `${idp.entityID}!${found[0]}:${found[1]}` } : { error: 'no_identifier' };
}

/**
 * Finds the account a SAML login continues as: by NameID, then by email. An account owned by
 * another provider or bound to a different NameID fails the login.
 */
export async function findSamlUser({
  findUser,
  nameID,
  email,
}: {
  findUser: FindUserByFields;
  nameID: string;
  email: string;
}): Promise<LoginUserResolution> {
  let user = await findUser({ samlId: nameID });
  logger.info(`[samlStrategy] User ${user ? 'found' : 'not found'} by SAML identity`);

  if (!user) {
    user = await findUser({ email });
    logger.info(`[samlStrategy] User ${user ? 'found' : 'not found'} by SAML email claim`);
  }

  if (user && user.provider !== 'saml') {
    logger.info(`[samlStrategy] SAML login conflicts with existing provider: ${user.provider}`);
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }

  if (user?.samlId && user.samlId !== nameID) {
    logger.warn('[samlStrategy] Refused SAML login with a different NameID');
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }

  return { user, error: null };
}

/**
 * Resolves the account a SAML login continues as once the strategy's policy checks pass. A
 * found account claims this login's NameID and profile atomically and continues under
 * `appConfig`, its own config, and keeps its role; without one, the user is created through
 * `createUserOnce` in `role` (USER when unset), which admits it under that role's config, and an
 * account a concurrent first login created is admitted like a found account and claimed the same
 * way. Returns the account with the config the login continues under.
 */
export async function provisionSamlUser({
  user,
  nameID,
  email,
  username,
  name,
  role,
  appConfig,
  getAppConfig,
  getBalanceConfig,
  findUser,
  createUserIfAbsent,
  findBalanceByUser,
  claimSamlIdentity,
}: {
  user: UserRecord | null;
  nameID: string;
  email: string;
  username: string;
  name: string;
  role?: string;
  appConfig: AppConfig;
  getAppConfig: GetAppConfig;
  getBalanceConfig: GetBalanceConfig;
  findUser: FindUserByFields;
  createUserIfAbsent: CreateUserIfAbsent;
  findBalanceByUser: FindBalanceByUser;
  claimSamlIdentity: (
    userId: string,
    samlId: string,
    profile: { username: string; name: string },
  ) => Promise<UserRecord | null>;
}): Promise<ProvisionedUser> {
  let account = user;
  let accountConfig = appConfig;
  if (!account) {
    const result = await createUserOnce({
      newUser: {
        provider: 'saml',
        samlId: nameID,
        username,
        email,
        emailVerified: true,
        name,
        ...(role ? { role } : {}),
      },
      email,
      getAppConfig,
      getBalanceConfig,
      strategyName: 'samlStrategy',
      lookup: () => findSamlUser({ findUser, nameID, email }),
      createUserIfAbsent,
      findBalanceByUser,
    });
    if (result.error !== null) return { user: null, error: result.error };
    if (result.created) return { user: result.user, appConfig: result.appConfig, error: null };
    account = result.user;
    accountConfig = result.appConfig;
  }

  const claimed = await claimSamlIdentity(account._id.toString(), nameID, { username, name });
  if (!claimed) {
    logger.warn('[samlStrategy] Refused a concurrent SAML identity binding');
    return { user: null, error: ErrorTypes.AUTH_FAILED };
  }
  return { user: claimed, appConfig: accountConfig, error: null };
}
