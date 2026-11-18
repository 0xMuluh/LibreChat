import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
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
});
