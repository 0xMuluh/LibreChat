import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import WorkspaceCanvas from '../WorkspaceCanvas';

const mockPost = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: { post: (url: string, body?: unknown) => mockPost(url, body) },
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => null,
  useMediaQuery: () => false,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: { id: 'u1' } }) }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { reportsMode: 'local' } }),
}));
jest.mock('../Workspace/WorkspaceHeader', () => () => null);
jest.mock('../Workspace/AgentCanvasFrame', () => () => null);
jest.mock('../Workspace/ReportPreviewFrame', () => () => null);
jest.mock('../Workspace/AgentLauncherCard', () => () => <p>{'launcher'}</p>);
// Reports on this computer, with no session of the user's.
jest.mock(
  '../Workspace/RoihuSessionCard',
  () =>
    function Card({ onSessionChange }: { onSessionChange: (active: boolean) => void }) {
      jest.requireActual('react').useEffect(() => onSessionChange(false), [onSessionChange]);
      return null;
    },
);

describe('WorkspaceCanvas', () => {
  it('says the agent is starting and asks again every few seconds until it answers', async () => {
    jest.useFakeTimers();
    mockPost.mockResolvedValue({ ticket: 't', openhandsBaseUrl: 'https://reports.example' });
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('not up yet'))
      .mockResolvedValue({ ok: true, json: async () => ({ conversations: [] }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      render(<WorkspaceCanvas project={{ _id: 'p1', name: 'P' } as never} />);
      expect(await screen.findByText('com_workspace_agent_starting')).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
      await act(() => jest.advanceTimersByTimeAsync(3000));
      expect(await screen.findByText('launcher')).toBeInTheDocument();
      // Once it answers, only the 2-minute refresh asks again.
      const sessions = () =>
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/omicsbase/session'));
      const asked = sessions().length;
      await act(() => jest.advanceTimersByTimeAsync(60_000));
      expect(sessions()).toHaveLength(asked);
    } finally {
      jest.useRealTimers();
    }
  });
});
