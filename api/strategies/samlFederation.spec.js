const { generateKeyPairSync } = require('node:crypto');
const { SignedXml } = require('xml-crypto');
const { SAML } = require('@node-saml/node-saml');
const { getFederationSamlOptions } = require('@librechat/api');

/** A response from the chosen identity provider, validated with its federation SAML options. */
describe('federated SAML responses', () => {
  const issuer = 'https://omicsbase.example';
  const idpEntityID = 'https://idp.helsinki.example/idp';
  const idpKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  function response() {
    const now = Date.now();
    const at = (ms) => new Date(now + ms).toISOString();
    return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0" IssueInstant="${at(0)}"><saml:Issuer>${idpEntityID}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${at(0)}"><saml:Issuer>${idpEntityID}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">n-1</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${at(300000)}" Recipient="${issuer}/oauth/saml/callback"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${at(-60000)}" NotOnOrAfter="${at(300000)}"><saml:AudienceRestriction><saml:Audience>${issuer}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion></samlp:Response>`;
  }

  function signResponse(xml) {
    const signed = new SignedXml({
      privateKey: idpKey.privateKey,
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });
    signed.addReference({
      xpath: "/*[local-name(.)='Response']",
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signed.computeSignature(xml, {
      location: { reference: "/*/*[local-name(.)='Issuer']", action: 'after' },
    });
    return signed.getSignedXml();
  }

  function validate(xml) {
    let options;
    getFederationSamlOptions(
      {
        samlIdp: { entityID: idpEntityID, entryPoint: 'x', certs: [idpKey.publicKey], scopes: [] },
      },
      (_error, value) => {
        options = value;
      },
    );
    const saml = new SAML({ issuer, callbackUrl: `${issuer}/oauth/saml/callback`, ...options });
    return saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(xml).toString('base64') });
  }

  it('rejects a response in which neither the response nor the assertion is signed', async () => {
    await expect(validate(response())).rejects.toThrow('Invalid signature');
  });

  it('accepts the same response once the identity provider signs it', async () => {
    const { profile } = await validate(signResponse(response()));
    expect(profile).toMatchObject({ issuer: idpEntityID, nameID: 'n-1' });
  });
});
