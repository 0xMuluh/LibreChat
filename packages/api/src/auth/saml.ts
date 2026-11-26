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

/**
 * The home organisation's domain of a SAML login: the scope of eduPersonPrincipalName, else
 * schacHomeOrganization, else the domain of `email`. With `scopes` (the issuing identity
 * provider's `shibmd:Scope` list from federation metadata), a domain they do not list is
 * skipped, so one identity provider cannot claim another's organisation.
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
  return candidates.find((domain) => domain && (!scopes || scopes.includes(domain)));
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

export type FederatedSamlSubject =
  | { samlId: string; error?: never }
  | { samlId?: never; error: 'email_out_of_scope' };

/**
 * The SAML identity a login through federation metadata is stored under. The home identity
 * provider (`homeIssuer`) keeps the plain NameID, so its existing accounts continue unchanged.
 * Any other provider's NameID becomes `<entityID>!<nameID>`, so one provider cannot assert
 * another's NameID, and its login is refused unless the email's domain is one of the provider's
 * metadata scopes, so it can neither reach nor claim an address in another organisation's domain.
 */
export function resolveFederatedSamlSubject({
  nameID,
  email,
  idp,
  homeIssuer,
}: {
  nameID: string;
  email: string;
  idp: { entityID: string; scopes: string[] };
  homeIssuer: string;
}): FederatedSamlSubject {
  if (idp.entityID === homeIssuer) {
    return { samlId: nameID };
  }
  const domain = domainOf(email);
  if (!domain || !idp.scopes.includes(domain)) {
    return { error: 'email_out_of_scope' };
  }
  return { samlId: `${idp.entityID}!${nameID}` };
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
