import { EModelEndpoint, normalizeEndpointName } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isUserProvided } from '~/utils';

/**
 * Whether enforced model specs let a request without a spec through to `endpoint`: it must be
 * listed in `modelSpecs.addedEndpoints` and be a custom endpoint whose key each user supplies,
 * so the user's own key pays for whichever model they pick.
 */
export function isOwnKeyAddedEndpoint(
  appConfig: Pick<AppConfig, 'modelSpecs' | 'endpoints'> | null | undefined,
  endpoint: string | null | undefined,
): boolean {
  if (!endpoint) {
    return false;
  }
  const name = normalizeEndpointName(endpoint);
  const added = appConfig?.modelSpecs?.addedEndpoints ?? [];
  if (!added.some((entry) => normalizeEndpointName(entry) === name)) {
    return false;
  }
  const custom = appConfig?.endpoints?.[EModelEndpoint.custom] ?? [];
  const config = custom.find((entry) => normalizeEndpointName(entry.name) === name);
  return isUserProvided(config?.apiKey);
}
