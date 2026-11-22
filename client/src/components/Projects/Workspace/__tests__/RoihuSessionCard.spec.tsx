import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RoihuSessionCard from '../RoihuSessionCard';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  request: {
    get: (url: string) => mockGet(url),
    post: (url: string, body?: unknown) => mockPost(url, body),
    delete: (url: string) => mockDelete(url),
  },
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key} ${Object.values(vars).join(' ')}` : key,
}));
// The helix behind the card redraws on every animation frame, which makes moving a fake clock
// forward by minutes take longer than a test may.
jest.mock('~/components/HelixBackground', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockDelete.mockReset();
});

describe('RoihuSessionCard', () => {
  it('shows the launch form with the agreed defaults when there is no session', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    expect(await screen.findByLabelText('com_roihu_project')).toHaveValue('');
    expect(screen.getByLabelText('com_roihu_cores')).toHaveValue(2);
    expect(screen.getByLabelText('com_roihu_memory')).toHaveValue(8);
    expect(screen.getByLabelText('com_roihu_hours')).toHaveValue(4);
    expect(screen.getByLabelText('com_roihu_token')).toHaveAttribute('type', 'password');
  });

  it('marks invalid fields, moves focus to the first one and does not submit', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'com_roihu_launch' }));
    const project = screen.getByLabelText('com_roihu_project');
    expect(project).toHaveAttribute('aria-invalid', 'true');
    expect(project).toHaveAccessibleDescription(expect.stringContaining('com_roihu_err_project'));
    expect(screen.getByLabelText('com_roihu_token')).toHaveAttribute('aria-invalid', 'true');
    expect(project).toHaveFocus();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('launches with the entered values and shows the preparing state', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    mockPost.mockResolvedValue({ state: 'preparing', project: 'project_2010578' });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('com_roihu_project'), 'project_2010578');
    await user.type(screen.getByLabelText('com_roihu_token'), 'tok');
    await user.click(screen.getByRole('button', { name: 'com_roihu_launch' }));
    expect(mockPost).toHaveBeenCalledWith('/api/roihu/session', {
      project: 'project_2010578',
      cores: 2,
      memory: 8,
      hours: 4,
      token: 'tok',
    });
    expect(
      await screen.findByText('com_roihu_preparing_title project_2010578'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'com_roihu_launch' })).not.toBeInTheDocument();
  });

  it('shows the server error and keeps the form when the launch is refused', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    mockPost.mockRejectedValue({
      response: { data: { error: 'Your CSC account is not a member of project_2010578.' } },
    });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('com_roihu_project'), 'project_2010578');
    await user.type(screen.getByLabelText('com_roihu_token'), 'tok');
    await user.click(screen.getByRole('button', { name: 'com_roihu_launch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not a member of project_2010578');
    expect(screen.getByRole('button', { name: 'com_roihu_launch' })).toBeInTheDocument();
  });

  it('connects a running session in a hidden frame, then shows the session bar', async () => {
    mockGet.mockResolvedValue({
      state: 'running',
      project: 'project_2010578',
      cores: 2,
      memory: 8,
      endsAt: 2e9,
    });
    mockPost.mockResolvedValue({ url: 'https://openhands.example/roihu/open?c=abc' });
    const onConnectedChange = jest.fn();
    render(<RoihuSessionCard onConnectedChange={onConnectedChange} />);
    const frame = await screen.findByTitle('com_roihu_frame_title');
    expect(frame).toHaveAttribute('src', 'https://openhands.example/roihu/open?c=abc');
    expect(mockPost).toHaveBeenCalledWith('/api/roihu/session/open', undefined);
    expect(onConnectedChange).toHaveBeenLastCalledWith(false);

    // A message from another origin does not count.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { type: 'omicsbase:roihu-open' },
      }),
    );
    expect(screen.queryByText('com_roihu_bar_running')).not.toBeInTheDocument();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://openhands.example',
        data: { type: 'omicsbase:roihu-open' },
      }),
    );
    expect(await screen.findByText('com_roihu_bar_running')).toBeInTheDocument();
    expect(screen.getByText(/project_2010578 2 8/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_roihu_stop' })).toBeInTheDocument();
    expect(screen.queryByLabelText('com_roihu_project')).not.toBeInTheDocument();
    expect(onConnectedChange).toHaveBeenLastCalledWith(true);
  });

  it('offers to try again when this browser cannot connect', async () => {
    mockGet.mockResolvedValue({ state: 'running', project: 'project_2010578', endsAt: 2e9 });
    mockPost.mockRejectedValueOnce(new Error('down'));
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    expect(await screen.findByText('com_roihu_connect_failed')).toBeInTheDocument();
    mockPost.mockResolvedValue({ url: 'https://openhands.example/roihu/open?c=def' });
    await userEvent.click(screen.getByRole('button', { name: 'com_roihu_retry' }));
    expect(await screen.findByTitle('com_roihu_frame_title')).toHaveAttribute(
      'src',
      'https://openhands.example/roihu/open?c=def',
    );
  });

  it('shows the pairing command for a computer of their own, then follows the paired machine', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    const command = 'docker run ... https://omicsbase.example --pair ABCDE-FGHJK';
    mockPost.mockResolvedValue({ code: 'ABCDE-FGHJK', expires: 2e9, command });
    jest.useFakeTimers({ advanceTimers: true });
    try {
      render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.click(await screen.findByRole('button', { name: 'com_roihu_attach_start' }));
      expect(mockPost).toHaveBeenCalledWith('/api/roihu/attach', undefined);
      expect(await screen.findByText(command)).toBeInTheDocument();
      expect(screen.getByText('com_roihu_attach_waiting')).toBeInTheDocument();
      expect(screen.queryByLabelText('com_roihu_project')).not.toBeInTheDocument();

      mockGet.mockResolvedValue({ state: 'offline', machine: 'lab-pc' });
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await screen.findByText('com_roihu_offline_title lab-pc')).toBeInTheDocument();
      // The command goes one render after the session arrives.
      await waitFor(() => expect(screen.queryByText(command)).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'com_roihu_disconnect' })).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts the pairing code down on the server clock, then offers a new code', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    const image = 'ghcr.io/0xmuluh/omicsbase-reports:v1';
    const first = `docker run ... ${image} https://omicsbase.example --pair AAAAA-AAAAA`;
    const second = `docker run ... ${image} https://omicsbase.example --pair BBBBB-BBBBB`;
    // The server's clock is far from this browser's: only the two minutes between count.
    mockPost.mockResolvedValueOnce({ now: 5000, expires: 5120, image, command: first });
    mockPost.mockResolvedValueOnce({ now: 6000, expires: 6600, image, command: second });
    jest.useFakeTimers({ advanceTimers: true });
    try {
      render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
      await user.click(await screen.findByRole('button', { name: 'com_roihu_attach_start' }));
      expect(await screen.findByText(`docker pull ${image}`)).toBeInTheDocument();
      expect(screen.getByText('com_roihu_attach_pull')).toBeInTheDocument();
      expect(screen.getByText(first)).toBeInTheDocument();
      expect(screen.getByText(/com_roihu_attach_valid 2:00/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'com_roihu_attach_copy' })).toHaveLength(2);

      await jest.advanceTimersByTimeAsync(61_000);
      expect(screen.getByText(/com_roihu_attach_valid 0:59/)).toBeInTheDocument();

      await jest.advanceTimersByTimeAsync(59_000);
      expect(await screen.findByText('com_roihu_attach_expired')).toBeInTheDocument();
      expect(screen.queryByText(first)).not.toBeInTheDocument();
      expect(screen.queryByText(/com_roihu_attach_waiting/)).not.toBeInTheDocument();
      expect(screen.getByText(`docker pull ${image}`)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'com_roihu_attach_new_code' }));
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(mockPost).toHaveBeenLastCalledWith('/api/roihu/attach', undefined);
      expect(await screen.findByText(second)).toBeInTheDocument();
      expect(screen.getByText(/com_roihu_attach_valid 10:00/)).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  it('says a newly linked machine is connecting, and when it cannot be reached', async () => {
    mockGet.mockResolvedValue({ state: 'linking', machine: 'lab.example.org' });
    const { unmount } = render(<RoihuSessionCard local onConnectedChange={jest.fn()} />);
    expect(await screen.findByText('com_roihu_linking_title lab.example.org')).toBeInTheDocument();
    expect(screen.getByText('com_roihu_linking_body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_roihu_disconnect' })).toBeInTheDocument();
    unmount();

    const message = 'OmicsBase cannot reach lab.example.org on port 8443.';
    mockGet.mockResolvedValue({ state: 'offline', machine: 'lab.example.org', message });
    render(<RoihuSessionCard local onConnectedChange={jest.fn()} />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText('com_roihu_offline_body')).not.toBeInTheDocument();
  });

  it.each([
    [{ tokenExpires: 2e9, launchedAt: 1.99e9 }, 'com_roihu_bar_token_until'],
    [{ launchedAt: 1.99e9 }, 'com_roihu_bar_launched'],
  ])('says in the session bar how long the CSC token lasts', async (times, key) => {
    mockGet.mockResolvedValue({ state: 'running', project: 'project_2010578', ...times });
    mockPost.mockResolvedValue({ url: 'https://openhands.example/roihu/open?c=abc' });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    await screen.findByTitle('com_roihu_frame_title');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://openhands.example',
        data: { type: 'omicsbase:roihu-open' },
      }),
    );
    expect(await screen.findByText(new RegExp(key))).toBeInTheDocument();
  });

  it('after an ended session, shows why and offers the launch form again', async () => {
    const message = 'Preparing the Reports image failed. Launch again to retry.';
    mockGet.mockResolvedValue({ state: 'ended', message });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_roihu_launch' })).toBeEnabled();
  });

  it('names the attached machine in the session bar', async () => {
    mockGet.mockResolvedValue({ state: 'running', machine: 'lab-pc' });
    mockPost.mockResolvedValue({ url: 'https://openhands.example/roihu/open?c=abc' });
    render(<RoihuSessionCard onConnectedChange={jest.fn()} />);
    await screen.findByTitle('com_roihu_frame_title');
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://openhands.example',
        data: { type: 'omicsbase:roihu-open' },
      }),
    );
    expect(await screen.findByText('com_roihu_bar_machine lab-pc')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_roihu_disconnect' })).toBeInTheDocument();
  });

  it('in a local install, links a machine from its pairing string', async () => {
    mockGet.mockResolvedValue({ state: 'none' });
    const command = 'docker run ... serve --address <name or IP of that computer>';
    mockPost.mockImplementation(async (url: string) =>
      url === '/api/roihu/attach' ? { command } : { state: 'offline', machine: 'lab.example.org' },
    );
    const onSessionChange = jest.fn();
    render(
      <RoihuSessionCard local onConnectedChange={jest.fn()} onSessionChange={onSessionChange} />,
    );
    const user = userEvent.setup();
    expect(await screen.findByText('com_roihu_local_bar')).toBeInTheDocument();
    expect(onSessionChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByLabelText('com_roihu_project')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'com_roihu_attach_start' }));
    expect(await screen.findByText(command)).toBeInTheDocument();
    const connect = screen.getByRole('button', { name: 'com_roihu_link_connect' });
    expect(connect).toBeDisabled();
    await user.type(screen.getByLabelText('com_roihu_link_label'), '  omicsbase-machine:abc  ');
    await user.click(connect);
    expect(mockPost).toHaveBeenLastCalledWith('/api/roihu/attach/link', {
      pairing: 'omicsbase-machine:abc',
    });
    expect(await screen.findByText('com_roihu_offline_title lab.example.org')).toBeInTheDocument();
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
  });

  it('after a disconnect, undoes the open page before Reports goes back to this computer', async () => {
    localStorage.setItem('omicsbase_reports_open_origin', 'http://localhost:3001');
    mockGet.mockResolvedValue({ state: 'offline', machine: 'lab.example.org' });
    mockDelete.mockResolvedValue({ state: 'ended', message: 'Disconnected from lab.example.org.' });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onSessionChange = jest.fn();
    render(
      <RoihuSessionCard local onConnectedChange={jest.fn()} onSessionChange={onSessionChange} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'com_roihu_disconnect' }));
    expect(await screen.findByText('Disconnected from lab.example.org.')).toBeInTheDocument();
    expect(screen.getByTitle('com_roihu_frame_title')).toHaveAttribute(
      'src',
      'http://localhost:3001/roihu/close',
    );
    expect(onSessionChange).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3001',
        data: { type: 'omicsbase:roihu-closed' },
      }),
    );
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(false));
    expect(screen.queryByTitle('com_roihu_frame_title')).not.toBeInTheDocument();
  });
});
