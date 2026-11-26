import { SignedXml } from 'xml-crypto';
import { generateKeyPairSync } from 'node:crypto';

export const UTU_IDP = 'https://idp.utu.example/idp';

/** A federation signing key pair made for the test run; `cert` is its public key. */
export function makeSigner(): { cert: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { cert: publicKey, privateKey };
}

/** A small aggregate: one usable identity provider, one without a Redirect endpoint, one SP. */
export function metadataXml(validUntil: string | null = '2099-01-01T00:00:00Z'): string {
  const until = validUntil ? ` validUntil="${validUntil}"` : '';
  const key = (use: string | null, cert: string) =>
    `<KeyDescriptor${use ? ` use="${use}"` : ''}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
      ${cert}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>`;
  return `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:shibmd="urn:mace:shibboleth:metadata:1.0" ID="fed"${until}>
  <EntityDescriptor entityID="${UTU_IDP}" ID="utu">
    <Extensions><shibmd:Scope regexp="false">turku.example</shibmd:Scope></Extensions>
    <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <Extensions>
        <shibmd:Scope regexp="false">UTU.fi</shibmd:Scope>
        <shibmd:Scope regexp="true">^.+\\.utu\\.fi$</shibmd:Scope>
      </Extensions>
      ${key('signing', 'U0lHTklORw==')}
      ${key(null, 'Qk9USA==')}
      ${key('encryption', 'RU5DUllQVA==')}
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.utu.example/post"/>
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.utu.example/redirect"/>
    </IDPSSODescriptor>
  </EntityDescriptor>
  <EntityDescriptor entityID="https://idp.post-only.example/idp">
    <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      ${key('signing', 'UE9TVA==')}
      <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.post-only.example/post"/>
    </IDPSSODescriptor>
  </EntityDescriptor>
  <EntityDescriptor entityID="https://sp.example">
    <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example/acs" index="1"/>
    </SPSSODescriptor>
  </EntityDescriptor>
</EntitiesDescriptor>`;
}

/**
 * Signs `xml` the way federations do: an enveloped exc-c14n RSA-SHA256 signature on the root,
 * or on the element `xpath` selects.
 */
export function signMetadata(xml: string, privateKey: string, xpath = '/*'): string {
  const signed = new SignedXml({
    privateKey,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  });
  signed.addReference({
    xpath,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signed.computeSignature(xml, { location: { reference: '/*', action: 'prepend' } });
  return signed.getSignedXml();
}
