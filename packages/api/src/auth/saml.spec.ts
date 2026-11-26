import {
  resolveSamlRole,
  resolveSamlSubject,
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
      [['utu.fi'], defaultRole],
      [['utu.fi', 'med.utu.fi'], 'UTU'],
    ])('trusts a subdomain ePPN only when listed in %p', (scopes, role) => {
      const profile = { eduPersonPrincipalName: 'user@med.utu.fi' };
      expect(resolveSamlRole({ profile, scopes, orgRoles, defaultRole })).toBe(role);
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
