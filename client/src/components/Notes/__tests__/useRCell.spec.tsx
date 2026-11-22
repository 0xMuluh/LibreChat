import { act, renderHook } from '@testing-library/react';
import type { NoteCell, NoteCellExecution } from '~/data-provider/Notes/notesCellsApi';
import { noteCellsApi } from '~/data-provider/Notes/notesCellsApi';
import { useRCell } from '../useRCell';

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/Providers', () => ({ useShareContext: () => ({ isSharedConvo: false }) }));
jest.mock('~/data-provider/Notes/notesCellsApi', () => ({
  ...jest.requireActual('~/data-provider/Notes/notesCellsApi'),
  noteCellsApi: {
    findCellByBlockKey: jest.fn(),
    createOrFindCell: jest.fn(),
    getExecution: jest.fn(),
    listExecutions: jest.fn(),
    cancel: jest.fn(),
  },
}));

const api = noteCellsApi as jest.Mocked<typeof noteCellsApi>;

const execution = (overrides: Partial<NoteCellExecution>): NoteCellExecution => ({
  id: 'e1',
  cellId: 'c1',
  revisionId: 'r1',
  attempt: 1,
  status: 'running',
  timeoutSeconds: 600,
  ...overrides,
});

const cell: NoteCell = {
  id: 'c1',
  conversationId: 'convo1',
  blockKey: 'tool-call_1',
  latestExecutionId: 'e1',
  latestExecution: execution({ status: 'queued', phase: 'starting_pod' }),
};

const tick = () => act(() => jest.advanceTimersByTimeAsync(1500));

const liveAgentCell = (props = {}) =>
  renderHook(() =>
    useRCell(
      {
        initialCode: 'tse <- addAlpha(tse)',
        isAgentGenerated: true,
        isParentRunning: true,
        blockKey: 'tool-call_1',
        ...props,
      },
      'convo1',
      'msg1',
    ),
  );

beforeEach(() => {
  jest.useFakeTimers();
  api.listExecutions.mockResolvedValue({ executions: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRCell: a live agent cell attaches by blockKey', () => {
  it('looks the cell up every 1.5 s until the run has created it, then follows the run', async () => {
    api.findCellByBlockKey.mockRejectedValueOnce(new Error('404')).mockResolvedValue(cell);
    api.getExecution
      .mockResolvedValueOnce(execution({ phase: 'running', stdout: 'step 1\n' }))
      .mockResolvedValue(execution({ status: 'completed', phase: null, stdout: 'step 1\ndone\n' }));

    const { result } = liveAgentCell();
    expect(result.current.isBootstrapping).toBe(true);
    expect(result.current.execution).toBeNull();

    await tick();
    expect(api.findCellByBlockKey).toHaveBeenCalledWith('convo1', 'tool-call_1');
    expect(result.current.execution).toBeNull();

    await tick();
    expect(api.findCellByBlockKey).toHaveBeenCalledTimes(2);
    expect(result.current.cellId).toBe('c1');
    expect(result.current.execution?.phase).toBe('starting_pod');
    expect(result.current.isBootstrapping).toBe(false);
    // Cancel is offered as soon as the run exists.
    expect(result.current.isActive).toBe(true);

    await tick();
    expect(api.getExecution).toHaveBeenCalledWith('convo1', 'c1', 'e1');
    expect(result.current.execution?.phase).toBe('running');
    expect(result.current.stdout).toBe('step 1\n');
    // The lookup stopped once attached.
    expect(api.findCellByBlockKey).toHaveBeenCalledTimes(2);

    await tick();
    expect(result.current.execution?.status).toBe('completed');
    expect(result.current.isActive).toBe(false);
  });

  it('cancels the attached run', async () => {
    api.findCellByBlockKey.mockResolvedValue(cell);
    api.getExecution.mockResolvedValue(execution({ phase: 'running' }));
    api.cancel.mockResolvedValue(execution({ phase: 'running', cancelRequested: true }));

    const { result } = liveAgentCell();
    await tick();
    await act(() => result.current.handleCancel());

    expect(api.cancel).toHaveBeenCalledWith('convo1', 'c1', 'e1');
    expect(result.current.execution?.cancelRequested).toBe(true);
  });

  it('does not look up when the cell is already known or the note is not saved yet', async () => {
    liveAgentCell({ cellId: 'c9' });
    renderHook(() =>
      useRCell(
        { initialCode: 'x', isAgentGenerated: true, isParentRunning: true, blockKey: 'tool-a' },
        'new',
        'msg1',
      ),
    );
    await tick();
    expect(api.findCellByBlockKey).not.toHaveBeenCalled();
  });

  it('stops looking up on unmount', async () => {
    api.findCellByBlockKey.mockRejectedValue(new Error('404'));
    const { unmount } = liveAgentCell();
    await tick();
    unmount();
    await tick();
    expect(api.findCellByBlockKey).toHaveBeenCalledTimes(1);
  });

  it('still takes the result from the tool output when the run ends', async () => {
    api.findCellByBlockKey.mockRejectedValue(new Error('404'));
    api.getExecution.mockResolvedValue(execution({ status: 'completed', stdout: 'done\n' }));
    const output = 'done\n<!-- noteCell cellId=c1 executionId=e1 status=completed -->';

    const { result, rerender } = renderHook(
      ({ initialOutput, isParentRunning }: { initialOutput?: string; isParentRunning: boolean }) =>
        useRCell(
          {
            initialCode: 'x',
            initialOutput,
            isAgentGenerated: true,
            isParentRunning,
            blockKey: 'tool-call_1',
          },
          'convo1',
          'msg1',
        ),
      {
        initialProps: { initialOutput: undefined, isParentRunning: true } as {
          initialOutput?: string;
          isParentRunning: boolean;
        },
      },
    );
    await tick();
    rerender({ initialOutput: output, isParentRunning: false });
    await tick();

    expect(result.current.cellId).toBe('c1');
    expect(result.current.execution?.status).toBe('completed');
    expect(result.current.isBootstrapping).toBe(false);
    expect(api.findCellByBlockKey).toHaveBeenCalledTimes(1);
  });
});
