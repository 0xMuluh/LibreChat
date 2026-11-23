import { act, renderHook } from '@testing-library/react';
import type { NoteCell, NoteCellExecution } from '~/data-provider/Notes/notesCellsApi';
import { noteCellsApi } from '~/data-provider/Notes/notesCellsApi';
import { useRCell } from '../useRCell';

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
const mockShareContext = { isSharedConvo: false };
jest.mock('~/Providers', () => ({ useShareContext: () => mockShareContext }));
jest.mock('~/data-provider/Notes/notesCellsApi', () => ({
  ...jest.requireActual('~/data-provider/Notes/notesCellsApi'),
  noteCellsApi: {
    findCellByBlockKey: jest.fn(),
    createOrFindCell: jest.fn(),
    getCell: jest.fn(),
    appendRevision: jest.fn(),
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
  mockShareContext.isSharedConvo = false;
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

describe('useRCell: the code shown is the code that runs', () => {
  const toolCode = 'tse <- addAlpha(tse)';
  const editedCode = 'tse <- addAlpha(tse, index = "shannon")';
  const revision = (number: number, content: string) => ({
    id: `r${number}`,
    cellId: 'c1',
    revision: number,
    language: 'r',
    content,
  });
  const storedCell = (number: number, content: string): NoteCell => ({
    id: 'c1',
    conversationId: 'convo1',
    blockKey: 'tool-call_1',
    revision: revision(number, content),
  });
  const reloadedAgentCell = () =>
    renderHook(() =>
      useRCell(
        { initialCode: toolCode, isAgentGenerated: true, blockKey: 'tool-call_1', cellId: 'c1' },
        'convo1',
        'msg1',
      ),
    );
  const toggle = (result: ReturnType<typeof reloadedAgentCell>['result']) =>
    act(() => result.current.setIsEditing((prev) => !prev));

  it('shows the saved revision after save and on toggling between edit and read view', async () => {
    api.createOrFindCell.mockResolvedValue(storedCell(1, toolCode));
    api.appendRevision.mockResolvedValue(revision(2, editedCode));

    const { result } = reloadedAgentCell();
    await tick();
    expect(result.current.code).toBe(toolCode);

    toggle(result);
    act(() => result.current.handleCodeChange(editedCode));
    expect(result.current.isDirty).toBe(true);
    await act(() => result.current.handleSave());

    expect(api.appendRevision).toHaveBeenCalledWith('convo1', 'c1', editedCode);
    expect(result.current.code).toBe(editedCode);
    expect(result.current.isDirty).toBe(false);

    toggle(result);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.code).toBe(editedCode);

    toggle(result);
    expect(result.current.code).toBe(editedCode);
    expect(result.current.isDirty).toBe(false);
  });

  it('shows the saved revision after a reload, also across toggles', async () => {
    api.createOrFindCell.mockResolvedValue(storedCell(2, editedCode));

    const { result } = reloadedAgentCell();
    expect(result.current.code).toBe(toolCode);
    await tick();

    expect(result.current.code).toBe(editedCode);
    expect(result.current.isDirty).toBe(false);

    toggle(result);
    toggle(result);
    expect(result.current.code).toBe(editedCode);
  });

  it('shows the tool call code for an agent cell that was never edited', async () => {
    api.createOrFindCell.mockResolvedValue(storedCell(1, `${toolCode}\n# stored copy`));

    const { result } = reloadedAgentCell();
    await tick();
    expect(result.current.code).toBe(toolCode);

    toggle(result);
    toggle(result);
    expect(result.current.code).toBe(toolCode);
    expect(result.current.isDirty).toBe(false);
  });
  it('shows the latest run after a reload, not the run of the tool call', async () => {
    api.createOrFindCell.mockResolvedValue({
      ...storedCell(2, editedCode),
      latestExecutionId: 'e2',
    });
    api.getExecution.mockImplementation(async (_convo, _cell, id) =>
      execution({ id, status: 'completed' }),
    );

    const { result } = renderHook(() =>
      useRCell(
        {
          initialCode: toolCode,
          isAgentGenerated: true,
          blockKey: 'tool-call_1',
          cellId: 'c1',
          executionId: 'e1',
        },
        'convo1',
        'msg1',
      ),
    );
    await tick();

    expect(api.getExecution).toHaveBeenCalledWith('convo1', 'c1', 'e2');
    expect(result.current.code).toBe(editedCode);
    expect(result.current.execution?.id).toBe('e2');
  });
});

describe('useRCell: a shared note shows what the owner sees', () => {
  const toolCode = 'tse <- addAlpha(tse)';
  const editedCode = 'tse <- addAlpha(tse, index = "shannon")';
  const toolOutput =
    '<!-- noteCell cellId=c1 executionId=e1 status=completed -->\n[cell_id: "c1"]\nrichness 12';
  const sharedCell = (number: number, content: string, latest: NoteCellExecution): NoteCell => ({
    id: 'c1',
    blockKey: 'tool-call_1',
    latestExecutionId: latest.id,
    revision: { id: `r${number}`, cellId: 'c1', revision: number, language: 'r', content },
    latestExecution: latest,
  });
  // In a shared view the message context carries the shareId as the conversation id.
  const sharedAgentCell = () =>
    renderHook(() =>
      useRCell(
        {
          initialCode: toolCode,
          initialOutput: toolOutput,
          isAgentGenerated: true,
          blockKey: 'tool-call_1',
          cellId: 'c1',
          executionId: 'e1',
        },
        'share1',
        'msg1',
      ),
    );

  beforeEach(() => {
    mockShareContext.isSharedConvo = true;
  });

  it('shows the saved revision and its latest run for a cell the owner edited and re-ran', async () => {
    const rerun = execution({ id: 'e2', revisionId: 'r2', status: 'completed', stdout: 'shannon' });
    api.getCell.mockResolvedValue(sharedCell(2, `${editedCode}\n`, rerun));

    const { result } = sharedAgentCell();
    await tick();

    expect(api.getCell).toHaveBeenCalledWith('share1', 'c1');
    expect(api.createOrFindCell).not.toHaveBeenCalled();
    expect(api.getExecution).not.toHaveBeenCalled();
    expect(result.current.code).toBe(editedCode);
    expect(result.current.isDirty).toBe(false);
    expect(result.current.execution?.id).toBe('e2');
    expect(result.current.stdout).toBe('shannon');
    expect(result.current.isBootstrapping).toBe(false);
  });

  it('shows the tool call code for a cell that was never edited', async () => {
    const run = execution({ id: 'e1', status: 'completed', stdout: 'richness 12' });
    api.getCell.mockResolvedValue(sharedCell(1, `${toolCode}\n# stored copy`, run));

    const { result } = sharedAgentCell();
    await tick();

    expect(result.current.code).toBe(toolCode);
    expect(result.current.execution?.id).toBe('e1');
  });

  it('follows a run the owner has in progress', async () => {
    const running = execution({ id: 'e2', status: 'running' });
    api.getCell.mockResolvedValue(sharedCell(2, editedCode, running));
    api.getExecution.mockResolvedValue(execution({ id: 'e2', status: 'completed' }));

    const { result } = sharedAgentCell();
    // Let the cell read settle without advancing the 1.5 s poll.
    await act(async () => {});
    expect(result.current.isActive).toBe(true);
    expect(api.getExecution).not.toHaveBeenCalled();

    await tick();
    expect(api.getExecution).toHaveBeenCalledWith('share1', 'c1', 'e2');
    expect(result.current.execution?.status).toBe('completed');
  });

  it('shows the tool output when the cell cannot be read', async () => {
    api.getCell.mockRejectedValue(new Error('404'));

    const { result } = sharedAgentCell();
    await tick();

    expect(result.current.code).toBe(toolCode);
    expect(result.current.execution?.id).toBe('e1');
    expect(result.current.execution?.markdown).toBe('[cell_id: "c1"]\nrichness 12');
  });
});
