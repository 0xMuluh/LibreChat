import React from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { NoteCellExecution } from '~/data-provider/Notes/notesCellsApi';
import { StatusLine, endingNotice, formatClock, useElapsedSeconds } from '../StatusLine';

jest.mock('~/hooks', () => {
  const en: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return {
    useLocalize: () => (key: string, values?: Record<string, unknown>) =>
      (en[key] ?? key).replace(/{{(\w+)}}/g, (_, name) => String(values?.[name] ?? '')),
  };
});

const NOW = Date.parse('2026-11-22T10:00:00.000Z');
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

const execution = (overrides: Partial<NoteCellExecution>): NoteCellExecution => ({
  id: 'e1',
  cellId: 'c1',
  revisionId: 'r1',
  attempt: 1,
  status: 'running',
  timeoutSeconds: 600,
  serverNow: new Date(NOW).toISOString(),
  ...overrides,
});

const line = () => screen.getByTestId('note-cell-status').textContent;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('StatusLine text per phase', () => {
  it.each([
    ['preparing_files', 'Copying your files to the note…'],
    ['waiting_for_slot', 'Waiting for a free R server (all are busy)… 0:12'],
    ['starting_pod', 'Starting R for this note (a first start can take 2 minutes)… 0:12'],
    ['waiting_for_cell', 'Waiting for the previous cell to finish…'],
    ['starting_r', 'Starting R…'],
    ['restoring_session', 'Restoring your saved session…'],
    ['interrupted', 'Interrupted'],
  ] as const)('%s', (phase, text) => {
    render(<StatusLine execution={execution({ phase, phaseStartedAt: ago(12) })} />);
    expect(line()).toBe(text);
  });

  it('running counts from the start of R, against the time limit', () => {
    render(
      <StatusLine
        execution={execution({ phase: 'running', phaseStartedAt: ago(42), rStartedAt: ago(42) })}
      />,
    );
    expect(line()).toBe('Running · 0:42 of 10:00');
  });

  it('a run just created, before its first phase, says its files are being copied', () => {
    render(<StatusLine execution={execution({ status: 'queued' })} />);
    expect(line()).toBe('Copying your files to the note…');
  });

  it('says Cancelling once a cancel is requested and the run has not ended', () => {
    render(
      <StatusLine
        execution={execution({ phase: 'running', rStartedAt: ago(42), cancelRequested: true })}
      />,
    );
    expect(line()).toBe('Cancelling…');
  });

  it('keeps endings short in the header and gives their sentence to the output panel', () => {
    const localize = (key: string) =>
      (jest.requireActual('~/locales/en/translation.json') as Record<string, string>)[key] ?? key;
    const stopped = 'Stopped after 10:00. R was restarted, so objects are gone.';
    const timedOut = execution({ status: 'timed_out', phase: null, error: stopped });
    const { rerender } = render(<StatusLine execution={timedOut} />);
    expect(line()).toBe('Timed out');
    expect(endingNotice(timedOut, localize)).toBe(stopped);

    const cancelled = execution({
      status: 'cancelled',
      phase: null,
      cancelRequested: true,
      error: 'Cancelled. R was restarted.',
    });
    rerender(<StatusLine execution={cancelled} />);
    expect(line()).toBe('Cancelled');
    expect(endingNotice(cancelled, localize)).toBe('Cancelled. R was restarted.');

    const interrupted = execution({ status: 'failed', phase: 'interrupted', error: null });
    expect(endingNotice(interrupted, localize)).toBe(
      'Interrupted by a server restart. Run the cell again.',
    );
    expect(endingNotice(execution({ status: 'failed', error: 'Error in x' }), localize)).toBeNull();
  });

  it('keeps the error of a failed run out of the status line', () => {
    render(
      <StatusLine execution={execution({ status: 'failed', phase: null, error: 'Error in x' })} />,
    );
    expect(line()).toBe('Failed');
  });

  it('shows a labelled spinner, not "Binding", before the run is known', () => {
    render(<StatusLine execution={null} isLoading />);
    expect(screen.getByText('Loading cell')).toBeInTheDocument();
    expect(screen.queryByText(/Binding/)).not.toBeInTheDocument();
  });

  it('shows nothing for a cell that has never run', () => {
    const { container } = render(<StatusLine execution={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('timer', () => {
  it('formats seconds as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(42)).toBe('0:42');
    expect(formatClock(600)).toBe('10:00');
  });

  it('ticks every second', () => {
    render(<StatusLine execution={execution({ phase: 'running', rStartedAt: ago(42) })} />);
    expect(line()).toBe('Running · 0:42 of 10:00');
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(line()).toBe('Running · 0:45 of 10:00');
  });

  it('uses the server clock when the browser clock is off', () => {
    // The browser is 30 s ahead of the server; R started 5 s ago by the server's clock.
    const serverNow = new Date(NOW - 30_000).toISOString();
    const startedAt = new Date(NOW - 35_000).toISOString();
    const { result } = renderHook(() => useElapsedSeconds(startedAt, serverNow));
    expect(result.current).toBe(5);
  });

  it('does not tick when inactive and returns null without a start', () => {
    const { result } = renderHook(() => useElapsedSeconds(ago(5), null, false));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(result.current).toBe(5);
    expect(renderHook(() => useElapsedSeconds(null, null)).result.current).toBeNull();
  });
});
