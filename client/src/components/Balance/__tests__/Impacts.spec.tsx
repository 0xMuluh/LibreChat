import { render, screen } from '@testing-library/react';
import type { TImpactsTotals } from 'librechat-data-provider';
import Impacts, { IMPACTS_DOCS_URL } from '../Impacts';

const totals = (over: Partial<TImpactsTotals> = {}): TImpactsTotals => ({
  energy: { min: 0.002, max: 0.006 },
  gwp: { min: 0.001, max: 0.003 },
  partial: false,
  ...over,
});

const none = { min: 0, max: 0 };

describe('Impacts', () => {
  it('shows the estimate of a note in Wh and g', () => {
    render(<Impacts totals={totals()} scope="note" />);
    expect(screen.getByTestId('impacts-note')).toHaveTextContent(
      'This note: about 2–6 Wh, 1–3 g CO₂e (estimate)',
    );
  });

  it('shows the estimate of the account', () => {
    render(
      <Impacts
        totals={totals({ energy: { min: 0.4, max: 1.2 }, gwp: { min: 0.15, max: 0.45 } })}
        scope="account"
      />,
    );
    expect(screen.getByTestId('impacts-account')).toHaveTextContent(
      'All your notes: about 0.4–1 kWh, 150–450 g CO₂e (estimate)',
    );
  });

  it('links to the page that explains the estimate', () => {
    render(<Impacts totals={totals()} scope="note" />);
    const link = screen.getByRole('link', { name: 'How this is estimated' });
    expect(link).toHaveAttribute('href', IMPACTS_DOCS_URL);
    expect(IMPACTS_DOCS_URL).toBe('https://omicsbase.utu.fi/docs/start/energy.html');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('says the estimate is partial when a model had none', () => {
    render(<Impacts totals={totals({ partial: true })} scope="note" />);
    expect(screen.getByTestId('impacts-note')).toHaveTextContent(
      'This note: about 2–6 Wh, 1–3 g CO₂e (estimate) Partial: some model calls have no estimate.',
    );
  });

  it('is not marked partial otherwise', () => {
    render(<Impacts totals={totals()} scope="note" />);
    expect(screen.getByTestId('impacts-note')).not.toHaveTextContent('Partial');
  });

  it('says so when no model used has an estimate', () => {
    render(<Impacts totals={{ energy: none, gwp: none, partial: true }} scope="note" />);
    expect(screen.getByTestId('impacts-note')).toHaveTextContent(
      'No energy estimate for these model calls',
    );
    expect(screen.getByTestId('impacts-note')).not.toHaveTextContent('about');
  });

  it('renders nothing before there is anything to report', () => {
    const { container, rerender } = render(<Impacts scope="note" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<Impacts totals={{ energy: none, gwp: none, partial: false }} scope="note" />);
    expect(container).toBeEmptyDOMElement();
  });
});
