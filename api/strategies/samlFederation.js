/** Holds the federation guard `setupSaml` creates, so the SAML routes can run it. */
let guard;

function setSamlFederationGuard(next) {
  guard = next;
}

/** Sends SAML sign-ins through federation discovery when federation metadata is configured. */
function samlFederation(req, res, next) {
  return guard ? guard(req, res, next) : next();
}

module.exports = { samlFederation, setSamlFederationGuard };
