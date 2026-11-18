import { roihuConfig } from './roihu';

/**
 * End this browser's access to the user's Reports sessions on Roihu: the router stops
 * accepting every routing cookie it has issued for the user, so the next person to sign
 * in on the same browser cannot reach them. The sessions keep running.
 */
export async function revokeWorkspaceSessions(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = roihuConfig(env);
  if (!config || !userId) {
    return;
  }
  const url = `${config.routerUrl.replace(/\/$/, '')}/users/${encodeURIComponent(userId)}/sign-out`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.routerSecret}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error('Workspace session revocation failed');
  }
}
