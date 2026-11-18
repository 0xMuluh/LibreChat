import { revokeWorkspaceSessions } from './logout';

const env = {
  ROIHU_ROUTER_URL: 'http://router.test:18096/',
  ROIHU_ROUTER_SECRET: 'admin-secret',
  ROIHU_IMAGE_TAG: 'v1',
  ROIHU_RELAY_URL: 'https://relay.test',
  ROIHU_RELAY_FINGERPRINT: 'fp',
  ROIHU_SCRIPTS_DIR: '/app/roihu',
};

describe('revokeWorkspaceSessions', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it("asks the router to end the user's routing cookies", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await revokeWorkspaceSessions('user/1', env);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://router.test:18096/users/user%2F1/sign-out',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer admin-secret' },
      }),
    );
  });

  it('reports a failed sign-out to the caller', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
    await expect(revokeWorkspaceSessions('u1', env)).rejects.toThrow('revocation failed');
  });

  it('does nothing when Reports on Roihu is not set up', async () => {
    await revokeWorkspaceSessions('u1', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
