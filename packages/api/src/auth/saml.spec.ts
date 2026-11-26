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
  const other = { entityID: 'https://login.helsinki.fi/shibboleth', scopes: ['helsinki.fi'] };

  test('keeps the plain NameID for the home identity provider', () => {
    const idp = { entityID: homeIssuer, scopes: ['utu.fi'] };
    expect(
      resolveFederatedSamlSubject({ nameID: 'n-1', email: 'user@gmail.com', idp, homeIssuer }),
    ).toEqual({ samlId: 'n-1' });
  });

  test("scopes another identity provider's NameID by its entityID", () => {
    expect(
      resolveFederatedSamlSubject({
        nameID: 'n-1',
        email: 'user@Helsinki.fi',
        idp: other,
        homeIssuer,
      }),
    ).toEqual({ samlId: 'https://login.helsinki.fi/shibboleth!n-1' });
  });

  test('refuses a subdomain email under a bare top-level scope', () => {
    const tld = { entityID: 'https://idp.example/shibboleth', scopes: ['fi'] };
    expect(
      resolveFederatedSamlSubject({ nameID: 'n-1', email: 'user@utu.fi', idp: tld, homeIssuer }),
    ).toEqual({ error: 'email_out_of_scope' });
  });

  test('accepts an email in a subdomain of one of its scopes', () => {
    expect(
      resolveFederatedSamlSubject({
        nameID: 'n-1',
        email: 'user@cs.helsinki.fi',
        idp: other,
        homeIssuer,
      }),
    ).toEqual({ samlId: 'https://login.helsinki.fi/shibboleth!n-1' });
  });

  test.each([
    'user@utu.fi',
    'user@nothelsinki.fi',
    'user@helsinki.fi.evil.com',
    'not an email',
    '',
  ])('refuses another identity provider asserting %p', (email) => {
    expect(resolveFederatedSamlSubject({ nameID: 'n-1', email, idp: other, homeIssuer })).toEqual({
      error: 'email_out_of_scope',
    });
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
