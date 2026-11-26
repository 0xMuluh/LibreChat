import { UTU_IDP, makeSigner, metadataXml, signMetadata } from './__fixtures__/metadata';
import { getSamlResponseIssuer, parseFederationMetadata } from './metadata';

describe('parseFederationMetadata', () => {
  const federation = makeSigner();
  const signed = signMetadata(metadataXml(), federation.privateKey);

  test('indexes the SAML identity providers of verified metadata', () => {
    const result = parseFederationMetadata(signed, federation.cert);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.validUntil).toEqual(new Date('2099-01-01T00:00:00Z'));
    expect([...result.value.idps.keys()]).toEqual([UTU_IDP]);
    expect(result.value.idps.get(UTU_IDP)).toEqual({
      entityID: UTU_IDP,
      entryPoint: 'https://idp.utu.example/redirect',
      certs: ['U0lHTklORw==', 'Qk9USA=='],
      scopes: ['utu.fi', 'turku.example'],
      persistent: true,
    });
  });

  test('verifies a signature whose prefix only the root element declares', () => {
    const xml = signMetadata(metadataXml(), federation.privateKey, '/*', 'ds').replace(
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
      '<ds:Signature',
    );

    expect(xml).toContain('<ds:Signature>');
    expect(parseFederationMetadata(xml, federation.cert)).toMatchObject({ ok: true });
  });

  test.each([
    ['a changed scope', signed.replace('UTU.fi</shibmd:Scope>', 'evil.fi</shibmd:Scope>')],
    [
      'an added identity provider',
      signed.replace(
        '</EntitiesDescriptor>',
        `<EntityDescriptor entityID="https://evil.example/idp"/></EntitiesDescriptor>`,
      ),
    ],
    ['another signing key', signMetadata(metadataXml(), makeSigner().privateKey)],
  ])('rejects metadata with %s', (_label, xml) => {
    const result = parseFederationMetadata(xml, federation.cert);
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_signature' } });
  });

  test('rejects a signature that covers only one entity', () => {
    const xml = signMetadata(metadataXml(), federation.privateKey, "//*[@ID='utu']");
    expect(parseFederationMetadata(xml, federation.cert)).toMatchObject({
      ok: false,
      error: { code: 'bad_signature' },
    });
  });

  test('rejects unsigned metadata', () => {
    expect(parseFederationMetadata(metadataXml(), federation.cert)).toMatchObject({
      ok: false,
      error: { code: 'unsigned' },
    });
  });

  test.each([
    ['expired', '2000-01-01T00:00:00Z'],
    ['without validUntil', null],
  ])('rejects metadata %s', (_label, validUntil) => {
    const xml = signMetadata(metadataXml(validUntil), federation.privateKey);
    expect(parseFederationMetadata(xml, federation.cert)).toMatchObject({
      ok: false,
      error: { code: 'expired' },
    });
  });

  test('rejects metadata once its validUntil has passed', () => {
    expect(
      parseFederationMetadata(signed, federation.cert, new Date('2100-01-01T00:00:00Z')),
    ).toMatchObject({ ok: false, error: { code: 'expired' } });
  });

  test.each(['not xml <', '<html/>'])('rejects %p as not metadata', (xml) => {
    expect(parseFederationMetadata(xml, federation.cert)).toMatchObject({
      ok: false,
      error: { code: 'invalid_xml' },
    });
  });
});

describe('getSamlResponseIssuer', () => {
  const encode = (xml: string) => Buffer.from(xml).toString('base64');
  const open =
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">';

  test('reads the Issuer of the response', () => {
    const xml = `${open}<saml:Issuer> ${UTU_IDP} </saml:Issuer><saml:Assertion><saml:Issuer>https://other.example</saml:Issuer></saml:Assertion></samlp:Response>`;
    expect(getSamlResponseIssuer(encode(xml))).toBe(UTU_IDP);
  });

  test('falls back to the Issuer of the assertion', () => {
    const xml = `${open}<saml:Assertion><saml:Issuer>${UTU_IDP}</saml:Issuer></saml:Assertion></samlp:Response>`;
    expect(getSamlResponseIssuer(encode(xml))).toBe(UTU_IDP);
  });

  test.each([
    [
      'a logout request',
      encode(
        `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${UTU_IDP}</saml:Issuer></samlp:LogoutRequest>`,
      ),
    ],
    ['a response without one', encode(`${open}</samlp:Response>`)],
    ['text that is not XML', 'not base64 xml'],
  ])('finds no issuer in %s', (_label, response) => {
    expect(getSamlResponseIssuer(response)).toBeUndefined();
  });
});
