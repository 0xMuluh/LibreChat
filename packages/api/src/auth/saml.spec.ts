import {
  resolveSamlRole,
  resolveSamlSubject,
  resolveFederatedSamlSubject,
  TRANSIENT_SAML_NAME_ID_FORMAT,
  type SamlSubjectProfile,
} from './saml';

describe('resolveSamlRole', () => {
  const EPPN_OID = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
  const SCHAC_OID = 'urn:oid:1.3.6.1.4.1.25178.1.2.9';
  const orgRoles = 'utu.fi:UTU';
  const defaultRole = 'GUEST';

  test.each([
    ['a utu.fi ePPN', { eduPersonPrincipalName: 'user@utu.fi' }, 'UTU'],
    ['a utu.fi ePPN under its OID name', { [EPPN_OID]: ['user@UTU.fi'] }, 'UTU'],
    ['a utu.fi subdomain', { eduPersonPrincipalName: 'user@med.utu.fi' }, 'UTU'],
    ['another university', { eduPersonPrincipalName: 'user@helsinki.fi' }, defaultRole],
    ['a lookalike domain', { eduPersonPrincipalName: 'user@notutu.fi' }, defaultRole],
    ['schacHomeOrganization', { schacHomeOrganization: 'utu.fi' }, 'UTU'],
    ['schacHomeOrganization under its OID name', { [SCHAC_OID]: 'utu.fi' }, 'UTU'],
  ])('gives %s its role', (_label, profile, role) => {
    expect(resolveSamlRole({ profile, email: 'user@other.org', orgRoles, defaultRole })).toBe(role);
  });

  test('prefers the ePPN scope to schacHomeOrganization and the email', () => {
    expect(
      resolveSamlRole({
        profile: { eduPersonPrincipalName: 'user@helsinki.fi', schacHomeOrganization: 'utu.fi' },
        email: 'user@utu.fi',
        orgRoles,
        defaultRole,
      }),
    ).toBe(defaultRole);
  });

  test('falls back to the email domain', () => {
    expect(resolveSamlRole({ profile: {}, email: 'user@utu.fi', orgRoles, defaultRole })).toBe(
      'UTU',
    );
  });

  test('gives the most specific matching domain', () => {
    expect(
      resolveSamlRole({
        profile: { eduPersonPrincipalName: 'user@med.utu.fi' },
        orgRoles: 'utu.fi:UTU, med.utu.fi:MED',
      }),
    ).toBe('MED');
  });

  test('gives no role when nothing matches and there is no default', () => {
    expect(resolveSamlRole({ profile: {}, email: 'user@helsinki.fi', orgRoles })).toBeUndefined();
  });

  test.each([undefined, '', '  '])('keeps the default role when unset: %p', (unset) => {
    const profile = { eduPersonPrincipalName: 'user@utu.fi' };
    expect(resolveSamlRole({ profile, orgRoles: unset, defaultRole: ' UTU ' })).toBe('UTU');
    expect(resolveSamlRole({ profile, orgRoles: unset })).toBeUndefined();
  });

  describe("with the identity provider's scopes", () => {
    const claims = { eduPersonPrincipalName: 'user@utu.fi', schacHomeOrganization: 'utu.fi' };

    test.each([
      ['its own domain', ['utu.fi'], 'UTU'],
      ['only a parent of its domain', ['fi'], defaultRole],
      ["another organisation's domain", ['helsinki.fi'], defaultRole],
      ['no domain', [], defaultRole],
    ])('trusts an identity provider scoped to %s accordingly', (_label, scopes, role) => {
      expect(
        resolveSamlRole({ profile: claims, email: 'user@utu.fi', scopes, orgRoles, defaultRole }),
      ).toBe(role);
    });

    test('skips an unscoped ePPN for a scoped schacHomeOrganization', () => {
      expect(
        resolveSamlRole({
          profile: { eduPersonPrincipalName: 'user@helsinki.fi', schacHomeOrganization: 'utu.fi' },
          scopes: ['utu.fi'],
          orgRoles: 'utu.fi:UTU, helsinki.fi:HY',
          defaultRole,
        }),
      ).toBe('UTU');
    });

    test.each([
      [['utu.fi'], 'UTU'],
      [['med.utu.fi'], 'UTU'],
      [['fi'], defaultRole],
      [['helsinki.fi'], defaultRole],
    ])('trusts a subdomain ePPN by its parent scope in %p', (scopes, role) => {
      const profile = { eduPersonPrincipalName: 'user@med.utu.fi' };
      expect(resolveSamlRole({ profile, scopes, orgRoles, defaultRole })).toBe(role);
    });
  });
});

describe('resolveFederatedSamlSubject', () => {
  const homeIssuer = 'https://sso.utu.fi/auth/realms/fed';
  const helsinki = 'https://login.helsinki.fi/shibboleth';
  const other = { entityID: helsinki, scopes: ['helsinki.fi'] };
  const TRANSIENT = TRANSIENT_SAML_NAME_ID_FORMAT;
  const PAIRWISE = 'urn:oasis:names:tc:SAML:attribute:pairwise-id';
  const SUBJECT = 'urn:oasis:names:tc:SAML:attribute:subject-id';
  const EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
  const resolve = (profile: Record<string, unknown>, email = 'user@helsinki.fi', idp = other) =>
    resolveFederatedSamlSubject({
      profile: { issuer: idp.entityID, ...profile },
      email,
      idp,
      homeIssuer,
    });

  describe('for the home identity provider', () => {
    const home = { entityID: homeIssuer, scopes: ['utu.fi'] };

    test('keeps the plain NameID whatever the email', () => {
      expect(resolve({ nameID: 'n-1' }, 'user@gmail.com', home)).toEqual({ samlId: 'n-1' });
    });

    test.each([
      [{ nameIDFormat: TRANSIENT, nameID: 'n-1', [PAIRWISE]: 'abc@utu.fi' }, 'transient_name_id'],
      [{ [EPPN]: 'user@utu.fi' }, 'missing_name_id'],
      [{ nameID: 'n-1', issuer: helsinki }, 'issuer_mismatch'],
    ])('still requires a persistent NameID from it: %p', (profile, error) => {
      expect(resolve(profile, 'user@utu.fi', home)).toEqual({ error });
    });
  });

  test("keys another identity provider's NameID by its entityID, as before", () => {
    expect(resolve({ nameID: 'n-1', [PAIRWISE]: 'abc@helsinki.fi' })).toEqual({
      samlId: `${helsinki}!n-1`,
    });
  });

  test('refuses a response from another issuer', () => {
    expect(resolve({ nameID: 'n-1', issuer: 'https://idp.evil.example' })).toEqual({
      error: 'issuer_mismatch',
    });
  });

  test.each([
    [
      'pairwise-id',
      { [PAIRWISE]: ' ABC=-1@Helsinki.fi ', [SUBJECT]: 's@helsinki.fi' },
      'pairwise:abc=-1@helsinki.fi',
    ],
    [
      'subject-id',
      { [SUBJECT]: 'S-1@helsinki.fi', [EPPN]: 'u@helsinki.fi' },
      'subject:s-1@helsinki.fi',
    ],
    ['ePPN', { [EPPN]: 'User@Helsinki.fi' }, 'eppn:user@helsinki.fi'],
    [
      'ePPN under its friendly name',
      { eduPersonPrincipalName: 'user@helsinki.fi' },
      'eppn:user@helsinki.fi',
    ],
    ['a subdomain scope', { [PAIRWISE]: 'abc@cs.helsinki.fi' }, 'pairwise:abc@cs.helsinki.fi'],
  ])('falls back from a transient NameID to %s', (_label, attributes, key) => {
    expect(resolve({ nameID: 't-1', nameIDFormat: TRANSIENT, ...attributes })).toEqual({
      samlId: `${helsinki}!${key}`,
    });
  });

  test('falls back when there is no NameID at all', () => {
    expect(resolve({ [SUBJECT]: 's-1@helsinki.fi' })).toEqual({
      samlId: `${helsinki}!subject:s-1@helsinki.fi`,
    });
  });

  test.each([
    ['a scope it does not list', 'abc@utu.fi'],
    ['a lookalike scope', 'abc@helsinki.fi.evil.com'],
    ['an underscore', 'a_b@helsinki.fi'],
    ['a leading hyphen', '-ab@helsinki.fi'],
    ['a scope with a leading period', 'abc@.helsinki.fi'],
    ['a unique ID over 127 characters', `${'a'.repeat(128)}@helsinki.fi`],
    ['no scope', 'abc'],
    ['two values', ['abc@helsinki.fi', 'def@helsinki.fi']],
  ])('skips a pairwise-id with %s', (_label, value) => {
    expect(
      resolve({ nameIDFormat: TRANSIENT, nameID: 't', [PAIRWISE]: value, [EPPN]: 'u@helsinki.fi' }),
    ).toEqual({ samlId: `${helsinki}!eppn:u@helsinki.fi` });
  });

  test('skips an ePPN outside its scopes', () => {
    expect(resolve({ nameIDFormat: TRANSIENT, nameID: 't', [EPPN]: 'user@utu.fi' })).toEqual({
      error: 'no_identifier',
    });
  });

  test.each(['pairwise:abc@helsinki.fi', 'subject:x', 'eppn:user@helsinki.fi'])(
    'does not key on a NameID shaped like another kind of key: %p',
    (nameID) => {
      expect(resolve({ nameID })).toEqual({ error: 'no_identifier' });
      expect(resolve({ nameID, [EPPN]: 'u@helsinki.fi' })).toEqual({
        samlId: `${helsinki}!eppn:u@helsinki.fi`,
      });
    },
  );

  test('refuses a login with none of the identifiers', () => {
    expect(resolve({ nameID: 't', nameIDFormat: TRANSIENT })).toEqual({ error: 'no_identifier' });
  });

  test('refuses a subdomain email under a bare top-level scope', () => {
    const tld = { entityID: 'https://idp.example/shibboleth', scopes: ['fi'] };
    expect(resolve({ nameID: 'n-1' }, 'user@utu.fi', tld)).toEqual({ error: 'email_out_of_scope' });
  });

  test('accepts an email in a subdomain of one of its scopes', () => {
    expect(resolve({ nameID: 'n-1' }, 'user@cs.helsinki.fi')).toEqual({
      samlId: `${helsinki}!n-1`,
    });
  });

  test.each([
    'user@utu.fi',
    'user@nothelsinki.fi',
    'user@helsinki.fi.evil.com',
    'not an email',
    '',
  ])('refuses another identity provider asserting %p', (email) => {
    expect(resolve({ nameID: 'n-1' }, email)).toEqual({ error: 'email_out_of_scope' });
  });
});

describe('resolveSamlSubject', () => {
  test.each<SamlSubjectProfile | null | undefined>([
    undefined,
    null,
    {},
    { nameID: '' },
    { nameID: '   ' },
  ])('rejects a missing or blank NameID: %p', (profile) => {
    expect(resolveSamlSubject(profile)).toEqual({ error: 'missing_name_id' });
  });

  test('rejects a transient NameID', () => {
    expect(
      resolveSamlSubject({ nameID: 'temporary-id', nameIDFormat: TRANSIENT_SAML_NAME_ID_FORMAT }),
    ).toEqual({ error: 'transient_name_id' });
  });

  test('preserves an opaque NameID exactly', () => {
    expect(resolveSamlSubject({ nameID: ' opaque-id ' })).toEqual({ nameID: ' opaque-id ' });
  });

  test('accepts the configured IdP issuer', () => {
    expect(
      resolveSamlSubject(
        { nameID: 'persistent-id', issuer: 'https://idp.example.com' },
        'https://idp.example.com',
      ),
    ).toEqual({ nameID: 'persistent-id' });
  });

  test.each([undefined, '', 'https://other-idp.example.com'])(
    'rejects a missing or different IdP issuer: %p',
    (issuer) => {
      expect(
        resolveSamlSubject({ nameID: 'persistent-id', issuer }, 'https://idp.example.com'),
      ).toEqual({ error: 'issuer_mismatch' });
    },
  );
});
