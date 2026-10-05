import { buildLoginRedirectUrl } from 'librechat-data-provider';

/** A fresh start: these paths show the public landing page instead of the login. */
const LANDING_PATHS = new Set(['/', '/c/new']);

/**
 * OmicsBase: where a signed-out visitor goes. Starting fresh ("/" or a new note)
 * opens the landing page, keeping any `?prompt=`; any other page goes to the
 * login and comes back afterwards.
 */
export function buildSignedOutRedirectUrl(pathname?: string, search?: string, hash?: string) {
  const path = pathname ?? window.location.pathname;
  if (LANDING_PATHS.has(path)) {
    return `/welcome${search ?? window.location.search}`;
  }
  return buildLoginRedirectUrl(pathname, search, hash);
}
