import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { NoteBookRef, NoteBookRefs } from '~/data-provider/Notes/notesCellsApi';
import { BookRefs } from '../BookRefs';

jest.mock('~/hooks', () => {
  const en: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return {
    useLocalize: () => (key: string, values?: Record<string, unknown>) =>
      (en[key] ?? key).replace(/{{(\w+)}}/g, (_, name) => String(values?.[name] ?? '')),
  };
});

jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({
    render: element,
    description,
  }: {
    render: React.ReactElement;
    description: string;
  }) => jest.requireActual('react').cloneElement(element, { title: description }),
}));

const ref = (overrides: Partial<NoteBookRef>): NoteBookRef => ({
  function: 'addAlpha',
  package: 'mia',
  book: 'oma',
  book_short: 'OMA',
  book_title: 'Orchestrating Microbiome Analysis',
  chapter: 'Alpha diversity',
  heading: 'Alpha diversity',
  url: 'https://microbiome.github.io/OMA/docs/devel/pages/alpha_diversity.html',
  looked_up: false,
  ...overrides,
});

const alpha = ref({});
const other = ref({
  function: 'getDissimilarity',
  chapter: 'Community similarity',
  heading: 'Unsupervised ordination',
  url: 'https://microbiome.github.io/OMA/docs/devel/pages/beta_diversity.html#ordination',
});

const fromBook: NoteBookRefs = {
  status: 'from_book',
  shown: alpha,
  refs: [alpha, other],
  missing: [],
  book_versions: { oma: '1.0.0' },
};

describe('BookRefs', () => {
  it('renders nothing without book refs', () => {
    const { container } = render(<BookRefs bookRefs={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('from_book: one line linking to the section, with the caveat as tooltip', () => {
    render(<BookRefs bookRefs={fromBook} />);
    expect(screen.getByText('From the book')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /OMA › Alpha diversity/ });
    expect(link).toHaveTextContent('OMA › Alpha diversity');
    expect(link).toHaveAttribute('href', alpha.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute(
      'title',
      'The analysis functions in this cell (addAlpha) are used in this section of the book. This does not check that the analysis is right for your data.',
    );
  });

  it('from_book: the disclosure lists the other sections by function and the book version', () => {
    render(<BookRefs bookRefs={fromBook} />);
    const toggle = screen.getByRole('button', { name: 'Other book sections and book versions' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('getDissimilarity()')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('getDissimilarity()')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /OMA › Community similarity › Unsupervised ordination/ }),
    ).toHaveAttribute('href', other.url);
    expect(screen.getByText('Book versions: OMA 1.0.0')).toBeInTheDocument();
  });

  it('not_in_books: names the missing functions and links nowhere by default', () => {
    render(
      <BookRefs
        bookRefs={{
          status: 'not_in_books',
          shown: null,
          refs: [alpha],
          missing: [
            { function: 'LimROTS', package: 'LimROTS' },
            { function: 'addPERMANOVA', package: 'mia' },
          ],
          book_versions: { oma: '1.0.0' },
        }}
      />,
    );
    expect(screen.getByText('Not in the books: LimROTS(), addPERMANOVA()')).toBeInTheDocument();
    expect(screen.queryByText(/From the book/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Other book sections and book versions' }));
    expect(screen.getByText('addAlpha()')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /OMA › Alpha diversity/ })).toHaveAttribute(
      'href',
      alpha.url,
    );
  });

  it('not_in_books without matched refs has no disclosure', () => {
    render(
      <BookRefs
        bookRefs={{
          status: 'not_in_books',
          shown: null,
          refs: [],
          missing: [{ function: 'LimROTS', package: 'LimROTS' }],
          book_versions: {},
        }}
      />,
    );
    expect(screen.getByText('Not in the books: LimROTS()')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  const notInBooks: NoteBookRefs = {
    ...fromBook,
    status: 'not_in_books',
    shown: null,
    missing: [{ function: 'LimROTS', package: 'LimROTS' }],
  };

  it.each([
    ['from_book', fromBook],
    ['not_in_books', notInBooks],
  ] as const)('%s never claims the analysis was checked', (_status, bookRefs) => {
    const { container } = render(<BookRefs bookRefs={bookRefs} />);
    fireEvent.click(screen.getByRole('button'));
    expect(container.textContent).not.toMatch(/verified|correct/i);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
  });
});
