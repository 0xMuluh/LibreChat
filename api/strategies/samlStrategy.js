const fs = require('fs');
const path = require('path');
const passport = require('passport');
const { ErrorTypes } = require('librechat-data-provider');
const { hashToken, logger } = require('@librechat/data-schemas');
const { Strategy: SamlStrategy, MultiSamlStrategy } = require('@node-saml/passport-saml');
const {
  findSamlUser,
  getBalanceConfig,
  createFederation,
  combineFederations,
  provisionSamlUser,
  isEmailDomainAllowed,
  getAvatarFileStrategy,
  getAvatarSaveParams,
  resolveAppConfigForUser,
  resolvePreAuthAppConfig,
  resolveSamlRole,
  resolveSamlSubject,
  getFederationSamlOptions,
  resolveFederatedSamlSubject,
  createSamlFederationGuard,
  TRANSIENT_SAML_NAME_ID_FORMAT,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const {
  findUser,
  updateUser,
  findBalanceByUser,
  claimSamlIdentity,
  createUserIfAbsent,
} = require('~/models');
const { setSamlFederationGuard } = require('./samlFederation');
const { getAppConfig } = require('~/server/services/Config');
const paths = require('~/config/paths');

let crypto;
try {
  crypto = require('node:crypto');
} catch (err) {
  logger.error('[samlStrategy] crypto support is disabled!', err);
}

/**
 * Retrieves the certificate content from the given value.
 *
 * This function determines whether the provided value is a certificate string (RFC7468 format or
 * base64-encoded without a header) or a valid file path. If the value matches one of these formats,
 * the certificate content is returned. Otherwise, an error is thrown.
 *
 * @see https://github.com/node-saml/node-saml/tree/master?tab=readme-ov-file#configuration-option-idpcert
 * @param {string} value - The certificate string or file path.
 * @returns {string} The certificate content if valid.
 * @throws {Error} If the value is not a valid certificate string or file path.
 */
function getCertificateContent(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid input: SAML_CERT must be a string.');
  }

  // Check if it's an RFC7468 formatted PEM certificate
  const pemRegex = new RegExp(
    '-----BEGIN (CERTIFICATE|PUBLIC KEY)-----\n' + // header
      '([A-Za-z0-9+/=]{64}\n)+' + // base64 content (64 characters per line)
      '[A-Za-z0-9+/=]{1,64}\n' + //  base64 content (last line)
      '-----END (CERTIFICATE|PUBLIC KEY)-----', // footer
  );
  if (pemRegex.test(value)) {
    logger.info('[samlStrategy] Detected RFC7468-formatted certificate string.');
    return value;
  }

  // Check if it's a Base64-encoded certificate (no header)
  if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length % 4 === 0) {
    logger.info('[samlStrategy] Detected base64-encoded certificate string (no header).');
    return value;
  }

  // Check if file exists and is readable
  const certPath = path.normalize(path.isAbsolute(value) ? value : path.join(paths.root, value));
  if (fs.existsSync(certPath) && fs.statSync(certPath).isFile()) {
    try {
      logger.info(`[samlStrategy] Loading certificate from file: ${certPath}`);
      return fs.readFileSync(certPath, 'utf8').trim();
    } catch (error) {
      throw new Error(`Error reading certificate file: ${error.message}`);
    }
  }

  throw new Error('Invalid cert: SAML_CERT must be a valid file path or certificate string.');
}

/**
 * Retrieves the private key content from the given value (file path, PEM string, or base64).
 * @param {string} value - The private key string or file path.
 * @returns {string} The private key content.
 */
function getPrivateKeyContent(value) {
  if (typeof value !== 'string') {
    throw new Error('Invalid input: SAML_PRIVATE_KEY must be a string.');
  }

  // Check if file exists and is readable
  const keyPath = path.normalize(path.isAbsolute(value) ? value : path.join(paths.root, value));
  if (fs.existsSync(keyPath) && fs.statSync(keyPath).isFile()) {
    try {
      logger.info(`[samlStrategy] Loading private key from file: ${keyPath}`);
      return fs.readFileSync(keyPath, 'utf8').trim();
    } catch (error) {
      throw new Error(`Error reading private key file: ${error.message}`);
    }
  }

  // Check if it's already a PEM formatted private key
  if (value.includes('-----BEGIN') && value.includes('PRIVATE KEY-----')) {
    logger.info('[samlStrategy] Detected PEM formatted private key string.');
    return value.trim();
  }

  // Check if it's a Base64-encoded string
  if (/^[A-Za-z0-9+/=]+$/.test(value) && value.length % 4 === 0) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN') && decoded.includes('PRIVATE KEY-----')) {
        logger.info('[samlStrategy] Decoded base64-encoded private key string.');
        return decoded.trim();
      }
    } catch {
      // Fall through
    }
  }

  return value.trim();
}

/**
 * Retrieves a SAML claim from a profile object based on environment configuration.
 * @param {object} profile - Saml profile
 * @param {string} envVar - Environment variable name (SAML_*)
 * @param {string} defaultKey -  Default key to use if the environment variable is not set
 * @returns {string}
 */
function getSamlClaim(profile, envVar, defaultKey) {
  const claimKey = process.env[envVar];

  // Avoids accessing `profile[""]` when the environment variable is empty string.
  if (claimKey) {
    return profile[claimKey] ?? profile[defaultKey];
  }
  return profile[defaultKey];
}

function getEmail(profile) {
  return getSamlClaim(profile, 'SAML_EMAIL_CLAIM', 'email');
}

function getUserName(profile) {
  return getSamlClaim(profile, 'SAML_USERNAME_CLAIM', 'username');
}

function getGivenName(profile) {
  return (
    getSamlClaim(profile, 'SAML_GIVEN_NAME_CLAIM', 'given_name') ||
    profile['givenName'] ||
    profile['urn:oid:2.5.4.42'] ||
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']
  );
}

function getFamilyName(profile) {
  return (
    getSamlClaim(profile, 'SAML_FAMILY_NAME_CLAIM', 'family_name') ||
    profile['sn'] ||
    profile['surname'] ||
    profile['urn:oid:2.5.4.4'] ||
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']
  );
}

function getPicture(profile) {
  return getSamlClaim(profile, 'SAML_PICTURE_CLAIM', 'picture');
}

const resizeIdentityProviderAvatar = async (url, userId) => {
  if (!url) {
    return null;
  }

  try {
    return await resizeAvatar({ userId, input: url });
  } catch (error) {
    logger.error('[samlStrategy] Failed to process identity-provider avatar', error);
    return null;
  }
};

/**
 * Determines the full name of a user based on SAML profile and environment configuration.
 *
 * @param {Object} profile - The user profile object from SAML Connect
 * @returns {string} The determined full name of the user
 */
function getFullName(profile) {
  if (process.env.SAML_NAME_CLAIM && profile[process.env.SAML_NAME_CLAIM]) {
    logger.debug(`[samlStrategy] Using SAML_NAME_CLAIM: ${process.env.SAML_NAME_CLAIM}`);
    return profile[process.env.SAML_NAME_CLAIM];
  }

  // Check explicit full display name claims (standard in academic SAML / Keycloak)
  const displayName =
    profile['displayName'] ||
    profile['urn:oid:2.16.840.1.113730.3.1.241'] ||
    profile['cn'] ||
    profile['urn:oid:2.5.4.3'] ||
    profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];
  if (displayName && typeof displayName === 'string' && displayName.trim().length > 0) {
    return displayName.trim();
  }

  const givenName = getGivenName(profile);
  const familyName = getFamilyName(profile);

  if (givenName && familyName) {
    return `${givenName} ${familyName}`.trim();
  }

  if (givenName) {
    return givenName.trim();
  }
  if (familyName) {
    return familyName.trim();
  }

  // Smart fallback: if user has a firstname.lastname@domain email, parse and format as First Last
  const email = getEmail(profile);
  if (email && typeof email === 'string' && email.includes('@')) {
    const localPart = email.split('@')[0];
    if (localPart.includes('.')) {
      const parts = localPart.split('.').filter(Boolean);
      if (parts.length >= 2) {
        return parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  return getUserName(profile) || email;
}

/**
 * Converts an input into a string suitable for a username.
 * If the input is a string, it will be returned as is.
 * If the input is an array, elements will be joined with underscores.
 * In case of undefined or other falsy values, a default value will be returned.
 *
 * @param {string | string[] | undefined} input - The input value to be converted into a username.
 * @param {string} [defaultValue=''] - The default value to return if the input is falsy.
 * @returns {string} The processed input as a string suitable for a username.
 */
function convertToUsername(input, defaultValue = '') {
  if (typeof input === 'string') {
    return input;
  } else if (Array.isArray(input)) {
    return input.join('_');
  }

  return defaultValue;
}

/**
 * Creates a SAML authentication callback.
 * @param {boolean} [existingUsersOnly=false] - If true, only existing users will be authenticated.
 * @returns {Function} The SAML callback function for passport; with federation metadata it also
 * takes the identity provider the response was validated against.
 */
function createSamlCallback(existingUsersOnly = false) {
  return async (profile, done, idp) => {
    try {
      const userEmail = getEmail(profile) || '';
      const subject = idp
        ? resolveFederatedSamlSubject({
            profile,
            email: userEmail,
            idp,
            homeIssuer: process.env.SAML_IDP_ISSUER?.trim(),
          })
        : resolveSamlSubject(profile, process.env.SAML_IDP_ISSUER);
      if (subject.error) {
        logger.warn(`[samlStrategy] Rejected SAML subject: ${subject.error}`);
        return done(null, false, { message: ErrorTypes.AUTH_FAILED });
      }
      const nameID = idp ? subject.samlId : subject.nameID;
      logger.info('[samlStrategy] SAML authentication received');

      const baseConfig = await resolvePreAuthAppConfig(getAppConfig);
      if (!isEmailDomainAllowed(userEmail, baseConfig?.registration?.allowedDomains)) {
        logger.error(
          '[samlStrategy] Authentication blocked because the email domain is not allowed',
        );
        return done(null, false, { message: 'Email domain not allowed' });
      }

      const found = await findSamlUser({ findUser, nameID, email: userEmail });
      if (found.error) {
        return done(null, false, { message: ErrorTypes.AUTH_FAILED });
      }
      let user = found.user;

      let appConfig = user ? await resolveAppConfigForUser(getAppConfig, user) : baseConfig;

      if (!isEmailDomainAllowed(userEmail, appConfig?.registration?.allowedDomains)) {
        logger.error("[samlStrategy] Authentication blocked by the account's email-domain policy");
        return done(null, false, { message: 'Email domain not allowed' });
      }

      const fullName = getFullName(profile);

      const username = convertToUsername(
        getUserName(profile) || getGivenName(profile) || getEmail(profile),
      );

      if (!user && existingUsersOnly) {
        logger.error('[samlStrategy] Admin auth blocked because the user does not exist');
        return done(null, false, { message: 'User does not exist' });
      }

      const provisioned = await provisionSamlUser({
        user,
        nameID,
        email: userEmail,
        username,
        name: fullName,
        role: resolveSamlRole({
          profile,
          email: userEmail,
          scopes: idp?.scopes,
          orgRoles: process.env.SAML_ORG_ROLES,
          defaultRole: process.env.SAML_DEFAULT_ROLE,
        }),
        appConfig,
        getBalanceConfig,
        getAppConfig,
        findUser,
        createUserIfAbsent,
        findBalanceByUser,
        claimSamlIdentity,
      });
      if (provisioned.error) {
        return done(null, false, { message: provisioned.error });
      }
      ({ user, appConfig } = provisioned);

      const picture = getPicture(profile);
      if (picture && !user.avatar?.includes('manual=true')) {
        const userId = user._id.toString();
        const imageBuffer = await resizeIdentityProviderAvatar(picture, userId);
        if (imageBuffer) {
          let fileName;
          if (crypto) {
            fileName = (await hashToken(nameID)) + '.png';
          } else {
            fileName = userId + '.png';
          }

          const fileStrategy = getAvatarFileStrategy(appConfig, process.env.CDN_PROVIDER);
          const { saveBuffer } = getStrategyFunctions(fileStrategy);
          const imagePath = await saveBuffer(
            getAvatarSaveParams(fileStrategy, {
              fileName,
              userId,
              buffer: imageBuffer,
              tenantId: user.tenantId,
            }),
          );
          user.avatar = imagePath ?? '';
          user = await updateUser(user._id, user);
        }
      }

      logger.info(`[samlStrategy] Login success for user: ${user._id}`);

      done(null, user);
    } catch (err) {
      logger.error('[samlStrategy] Login failed', err);
      done(err);
    }
  };
}

/**
 * Returns the base SAML configuration shared by both regular and admin strategies.
 * @returns {object} The SAML configuration object.
 */
function getBaseSamlConfig() {
  const identifierFormat = process.env.SAML_NAME_ID_FORMAT?.trim();
  if (identifierFormat === TRANSIENT_SAML_NAME_ID_FORMAT) {
    throw new Error('SAML_NAME_ID_FORMAT must provide a stable, non-transient identifier');
  }
  const idpIssuer = process.env.SAML_IDP_ISSUER?.trim();
  const privateKey = process.env.SAML_PRIVATE_KEY?.trim()
    ? getPrivateKeyContent(process.env.SAML_PRIVATE_KEY.trim())
    : undefined;

  return {
    entryPoint: process.env.SAML_ENTRY_POINT,
    issuer: process.env.SAML_ISSUER,
    idpCert: getCertificateContent(process.env.SAML_CERT),
    wantAssertionsSigned: process.env.SAML_USE_AUTHN_RESPONSE_SIGNED === 'true' ? false : true,
    wantAuthnResponseSigned: process.env.SAML_USE_AUTHN_RESPONSE_SIGNED === 'true' ? true : false,
    signatureAlgorithm: process.env.SAML_SIGNATURE_ALGORITHM || 'sha256',
    ...(privateKey ? { privateKey, decryptionPvk: privateKey } : {}),
    ...(idpIssuer ? { idpIssuer } : {}),
    ...(identifierFormat ? { identifierFormat } : {}),
  };
}

async function setupSaml() {
  try {
    const baseConfig = getBaseSamlConfig();
    const samlConfig = {
      ...baseConfig,
      callbackUrl: process.env.SAML_CALLBACK_URL,
    };

    const metadataUrl = process.env.SAML_FEDERATION_METADATA_URL?.trim();
    if (metadataUrl) {
      setupSamlFederation(samlConfig, metadataUrl);
    } else {
      passport.use('saml', new SamlStrategy(samlConfig, createSamlCallback(false)));
    }
    setupSamlAdmin(baseConfig);
  } catch (err) {
    logger.error('[samlStrategy]', err);
  }
}

/**
 * Lets users of every identity provider in the federation metadata sign in: discovery picks the
 * identity provider and each request uses its entry point and certificates. With eduGAIN
 * metadata as well, its identity providers sign in too; Haka's copy wins for those in both.
 * @param {object} samlConfig - Our service provider settings.
 * @param {string} url - The federation metadata URL.
 */
function setupSamlFederation(samlConfig, url) {
  const discoveryUrl = process.env.SAML_DISCOVERY_URL?.trim();
  if (!discoveryUrl || !process.env.SAML_IDP_ISSUER?.trim()) {
    throw new Error(
      'SAML_FEDERATION_METADATA_URL requires SAML_DISCOVERY_URL and SAML_IDP_ISSUER (the home identity provider)',
    );
  }
  const federations = [
    createFederation({
      url,
      cert: getCertificateContent(process.env.SAML_FEDERATION_METADATA_CERT),
    }),
  ];
  const edugainUrl = process.env.SAML_FEDERATION_EDUGAIN_METADATA_URL?.trim();
  if (edugainUrl) {
    try {
      const cert = getCertificateContent(process.env.SAML_FEDERATION_EDUGAIN_METADATA_CERT);
      federations.push(createFederation({ url: edugainUrl, cert, listedNameIDFormats: true }));
    } catch (err) {
      logger.error('[samlStrategy] eduGAIN metadata left out', err);
    }
  }
  const federation = combineFederations(federations);
  federation.start();
  setSamlFederationGuard(
    createSamlFederationGuard({
      federation,
      discoveryUrl,
      edugainDiscoveryUrl:
        federations.length > 1
          ? process.env.SAML_FEDERATION_EDUGAIN_DISCOVERY_URL?.trim() || undefined
          : undefined,
      entityID: samlConfig.issuer,
      returnUrl: `${process.env.DOMAIN_SERVER}/oauth/saml`,
      failureRedirect: `${process.env.DOMAIN_CLIENT}/oauth/error`,
    }),
  );

  const verify = createSamlCallback(false);
  const options = {
    ...samlConfig,
    passReqToCallback: true,
    getSamlOptions: (req, done) =>
      getFederationSamlOptions(req, done, process.env.SAML_IDP_ISSUER.trim()),
  };
  passport.use(
    'saml',
    new MultiSamlStrategy(options, (req, profile, done) => verify(profile, done, req.samlIdp)),
  );
  logger.info('[samlStrategy] SAML federation configured.');
}

/**
 * Sets up the SAML strategy specifically for admin authentication.
 * Rejects users that don't already exist.
 * @param {object} [baseConfig] - Pre-parsed base SAML config to avoid redundant cert parsing.
 */
function setupSamlAdmin(baseConfig) {
  try {
    const samlAdminConfig = {
      ...(baseConfig ?? getBaseSamlConfig()),
      callbackUrl: `${process.env.DOMAIN_SERVER}/api/admin/oauth/saml/callback`,
    };

    passport.use('samlAdmin', new SamlStrategy(samlAdminConfig, createSamlCallback(true)));
    logger.info('[samlStrategy] Admin SAML strategy registered.');
  } catch (err) {
    logger.error('[samlStrategy] setupSamlAdmin', err);
  }
}

module.exports = { setupSaml, getCertificateContent, getPrivateKeyContent };
