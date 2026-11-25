import React from 'react';
import axios from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { triggerDownload } from '~/utils';
import { Output } from '../Output';

const mockShowToast = jest.fn();

jest.mock('axios');
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  triggerDownload: jest.fn(),
}));
jest.mock('~/hooks', () => {
  const en: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return {
    useLocalize: () => (key: string, values?: Record<string, unknown>) =>
      (en[key] ?? key).replace(/{{(\w+)}}/g, (_, name) => String(values?.[name] ?? '')),
  };
});
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
  TooltipAnchor: ({ render: element }: { render: React.ReactElement }) => element,
}));
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

const url = '/api/notes/c1/cells/a/executions/b/artifacts/t1/content';
const table = { file: 'counts.csv', rows: 2, cols: 3, markdown: '| a |', url };

const renderOutput = () =>
  render(
    <Output execution={null} stdout="" executionError={null} authPlotUrls={[]} tables={[table]} />,
  );

describe('Output table download', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the table with the signed-in client and saves it', async () => {
    global.URL.createObjectURL = jest.fn(() => 'blob:counts');
    (axios.get as jest.Mock).mockResolvedValue({ data: new Blob(['a,b\n']) });
    renderOutput();

    fireEvent.click(screen.getByLabelText('Download counts.csv'));

    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('blob:counts', 'counts.csv'));
    expect(axios.get).toHaveBeenCalledWith(url, { responseType: 'blob' });
  });

  it('says so when the download fails', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('404'));
    renderOutput();

    fireEvent.click(screen.getByLabelText('Download counts.csv'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' })),
    );
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});
