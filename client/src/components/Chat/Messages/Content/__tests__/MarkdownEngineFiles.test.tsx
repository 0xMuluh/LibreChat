import React from 'react';
import { RecoilRoot } from 'recoil';
import ReactMarkdown from 'react-markdown';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { a, img } from '../MarkdownComponents';

const plot =
  'https://omicsbase.utu.fi/omics-engine/projects/n1/runs/cell_7273889e/plots/plot_001.png';

const renderMarkdown = (markdown: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RecoilRoot>
        <ReactMarkdown components={{ a, img }}>{markdown}</ReactMarkdown>
      </RecoilRoot>
    </QueryClientProvider>,
  ).container;

describe('plots and tables a reply links at the notes engine', () => {
  it('shows such a link as its text only', () => {
    const container = renderMarkdown(
      `[View the volcano plot](${plot}) and ` +
        '[counts](/omics-engine/projects/n1/runs/cell_x/tables/counts.csv)',
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('View the volcano plot and counts');
  });

  it('replaces such an image with a note pointing at the cell', () => {
    const container = renderMarkdown(`![Volcano plot](${plot})`);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('(plot shown under the cell above)')).toBeInTheDocument();
  });

  it('keeps other links and images', () => {
    const container = renderMarkdown(
      '[OMA](https://microbiome.github.io/OMA/) ![x](https://example.com/x.png)',
    );
    expect(container.querySelector('a')).toHaveAttribute(
      'href',
      'https://microbiome.github.io/OMA/',
    );
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/x.png');
  });
});
