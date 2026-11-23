import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TBalanceResponse, TConversation, TImpactsTotals } from 'librechat-data-provider';
import type { TokenUsageView } from '~/hooks/Chat/useTokenUsage';
import { TokenCredits, AutoRefill } from '~/components/Nav/Settings/BillingControls';
import { contextBreakdownExpandedAtom } from './store';
import TokenUsage from './index';

const mockStartupConfig = jest.fn();
const mockBalance = jest.fn();
const mockTokenUsage = jest.fn();
const mockBalanceQuery = jest.fn();
const mockImpacts = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useGetUserBalance: (config?: { enabled?: boolean }) =>
    config?.enabled === false
      ? { data: undefined, isError: false, isFetched: false }
      : (mockBalanceQuery() ?? { data: mockBalance(), isError: false, isFetched: true }),
  useGetLangfuseSessionLinkQuery: () => ({ data: undefined }),
  useGetImpactsQuery: (conversationId?: string, config?: { enabled?: boolean }) =>
    config?.enabled === false ? { data: undefined } : { data: mockImpacts(conversationId) },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true }),
}));

jest.mock('~/hooks/Chat/useTokenUsage', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockTokenUsage(...args),
}));

jest.mock('~/hooks/Chat/useCompactConversation', () => ({
  __esModule: true,
  default: () => ({ compact: jest.fn(), canCompact: false, isCompacting: false }),
  supportsCompaction: () => false,
}));

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  ContextBreakdown: ({
    expanded,
    onExpandedChange,
  }: {
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
  }) => (
    <button
      type="button"
      data-testid="context-breakdown-stub"
      aria-expanded={expanded}
      onClick={() => onExpandedChange(!expanded)}
    />
  ),
}));

const NOW = Date.parse('2026-07-05T00:00:00.000Z');

const balance: TBalanceResponse = {
  tokenCredits: 3_100_000,
  autoRefillEnabled: true,
  refillAmount: 5_000_000,
  refillIntervalValue: 7,
  refillIntervalUnit: 'days',
  lastRefill: '2026-07-01T00:00:00.000Z',
};

const config = ({
  balanceEnabled = true,
  display = 'credits',
  contextUsage,
}: {
  balanceEnabled?: boolean;
  display?: string;
  contextUsage?: boolean;
} = {}) => ({
  balance: { enabled: balanceEnabled, startBalance: 20_000, display },
  interface: { contextUsage, currency: { code: 'USD', rate: 1 } },
});

const usage = (usedTokens: number) =>
  ({ usedTokens, maxTokens: 200_000, percent: (usedTokens / 200_000) * 100 }) as TokenUsageView;

const conversation = { conversationId: 'convo-1', endpoint: 'openAI' } as TConversation;

const renderGauge = () =>
  render(<TokenUsage index={0} conversation={conversation} isSubmitting={false} />);

const openCard = async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  await user.click(screen.getByTestId('token-usage'));
  return screen.findByRole('dialog');
};

describe('TokenUsage gauge', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockBalance.mockReturnValue(balance);
    mockTokenUsage.mockReturnValue(usage(0));
    mockBalanceQuery.mockReset();
    mockImpacts.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('stays hidden on a fresh chat when balance is off', () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false }));
    renderGauge();
    expect(screen.queryByTestId('token-usage')).not.toBeInTheDocument();
  });

  it('shows the balance on a fresh chat when balance is on', async () => {
    mockStartupConfig.mockReturnValue(config());
    renderGauge();
    const card = await openCard();
    expect(within(card).getByTestId('balance-summary')).toBeInTheDocument();
    expect(within(card).queryByTestId('context-breakdown-stub')).not.toBeInTheDocument();
  });

  it('places the balance below the context window', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockTokenUsage.mockReturnValue(usage(83_200));
    renderGauge();
    const card = await openCard();
    const context = within(card).getByTestId('context-breakdown-stub');
    const summary = within(card).getByTestId('balance-summary');
    expect(context.compareDocumentPosition(summary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps a balance-only gauge when context usage is off, without reading context', async () => {
    mockStartupConfig.mockReturnValue(config({ contextUsage: false, display: 'percent' }));
    renderGauge();
    expect(mockTokenUsage).not.toHaveBeenCalled();
    expect(screen.getByRole('meter', { name: 'Share of balance used' })).toHaveAttribute(
      'aria-valuenow',
      '38',
    );
    const card = await openCard();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('38% used');
  });

  it('reads an unknown display mode from an unvalidated override as credits', async () => {
    mockStartupConfig.mockReturnValue(config({ display: 'dollars' }));
    renderGauge();
    const card = await openCard();
    expect(within(card).getByRole('heading', { name: 'Balance' })).toBeInTheDocument();
    expect(within(card).getByTestId('balance-value')).toHaveTextContent('3,100,000 credits');
  });

  it('keeps the card inside the viewport', async () => {
    mockStartupConfig.mockReturnValue(config());
    renderGauge();
    const card = await openCard();
    expect(card).toHaveClass(
      'max-h-[calc(100dvh-1rem)]',
      'max-w-[calc(100vw-1rem)]',
      'overflow-y-auto',
    );
  });

  it('sizes expanded context relative to the viewport without widening balance-only cards', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockTokenUsage.mockReturnValue(usage(83_200));
    const store = createStore();
    store.set(contextBreakdownExpandedAtom, true);
    const { rerender } = render(
      <Provider store={store}>
        <TokenUsage index={0} conversation={conversation} isSubmitting={false} />
      </Provider>,
    );
    await openCard();
    /** The popover's frame carries the width; the card fills it. */
    const frame = () => screen.getByTestId('token-usage-card').parentElement;
    expect(frame()).toHaveClass('w-(--usage-card-wide)', 'max-w-full');
    mockTokenUsage.mockReturnValue(usage(0));
    rerender(
      <Provider store={store}>
        <TokenUsage index={0} conversation={{ ...conversation }} isSubmitting={false} />
      </Provider>,
    );
    expect(frame()).toHaveClass('w-72');
  });

  it('keeps the expanded breakdown choice across remounts', async () => {
    localStorage.clear();
    mockStartupConfig.mockReturnValue(config());
    mockTokenUsage.mockReturnValue(usage(83_200));
    const tree = () => (
      <Provider store={createStore()}>
        <TokenUsage index={0} conversation={conversation} isSubmitting={false} />
      </Provider>
    );
    const first = render(tree());
    await openCard();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    expect(screen.getByTestId('context-breakdown-stub')).toHaveAttribute('aria-expanded', 'false');
    await user.click(screen.getByTestId('context-breakdown-stub'));
    expect(screen.getByTestId('context-breakdown-stub')).toHaveAttribute('aria-expanded', 'true');
    first.unmount();

    render(tree());
    await openCard();
    expect(screen.getByTestId('context-breakdown-stub')).toHaveAttribute('aria-expanded', 'true');
    localStorage.clear();
  });

  it('tints the balance-only ring with the balance tone, amber until empty', () => {
    mockStartupConfig.mockReturnValue(config({ contextUsage: false }));
    mockBalance.mockReturnValue({ ...balance, tokenCredits: 400_000 });
    renderGauge();
    const meter = screen.getByRole('meter', { name: 'Share of balance used' });
    expect(meter).toHaveAttribute('aria-valuenow', '92');
    const ring = meter.querySelectorAll('circle')[1];
    expect(ring).toHaveClass('stroke-status-warning');
    expect(ring).not.toHaveClass('stroke-status-error');
  });

  it('exposes no valueless meter while the balance-only gauge has nothing to measure', () => {
    mockBalance.mockReturnValue({ tokenCredits: 900, autoRefillEnabled: false });
    mockStartupConfig.mockReturnValue({
      ...config({ contextUsage: false, display: 'percent' }),
      balance: { enabled: true, startBalance: 0, display: 'percent' },
    });
    renderGauge();
    expect(screen.getByTestId('token-usage')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('mounts nothing when both context usage and balance are off', () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false, contextUsage: false }));
    const { container } = renderGauge();
    expect(container).toBeEmptyDOMElement();
  });

  it('agrees with the card when auto-refill is on but the refill amount is not positive', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockBalance.mockReturnValue({ ...balance, refillAmount: 0 });
    renderGauge();
    const card = await openCard();
    expect(within(card).getByTestId('balance-refill')).toHaveTextContent(
      "Doesn't refill automatically",
    );
    const settings = render(<AutoRefill />);
    expect(settings.container).toHaveTextContent('Auto-Refill is disabled.');
    expect(settings.container).not.toHaveTextContent('Error loading auto-refill settings.');
  });

  it.each([
    ['loading', { data: undefined, isError: false, isFetched: false }, 'auto-refill-loading'],
    ['failed', { data: undefined, isError: true, isFetched: true }, 'alert'],
  ] as const)(
    'shows the auto-refill row %s on its own when settings search hides the balance row',
    (_state, query, marker) => {
      mockStartupConfig.mockReturnValue(config());
      mockBalanceQuery.mockReturnValue(query);
      const settings = render(<AutoRefill />);
      const node =
        marker === 'alert'
          ? within(settings.container).getByRole('alert')
          : within(settings.container).getByTestId(marker);
      expect(node).toBeInTheDocument();
      if (marker === 'alert') {
        expect(node).toHaveTextContent('Error loading auto-refill settings.');
      }
    },
  );

  const impactsTotals = (energy: number, gwp: number, partial = false): TImpactsTotals => ({
    energy: { min: energy, max: energy * 3 },
    gwp: { min: gwp, max: gwp * 3 },
    partial,
  });

  it('shows the energy estimate of the note in the card, not the account total', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockTokenUsage.mockReturnValue(usage(83_200));
    mockImpacts.mockReturnValue({
      account: impactsTotals(0.4, 0.15),
      note: impactsTotals(0.002, 0.001),
    });
    renderGauge();
    const card = await openCard();
    expect(mockImpacts).toHaveBeenCalledWith('convo-1');
    expect(within(card).getByTestId('impacts-note')).toHaveTextContent(
      'This note: about 2–6 Wh, 1–3 g CO₂e (estimate)',
    );
    expect(within(card).queryByTestId('impacts-account')).not.toBeInTheDocument();
  });

  it('marks the note estimate partial when a model had none', async () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false }));
    mockTokenUsage.mockReturnValue(usage(83_200));
    mockImpacts.mockReturnValue({
      account: impactsTotals(0.4, 0.15),
      note: impactsTotals(0.002, 0.001, true),
    });
    renderGauge();
    const card = await openCard();
    expect(within(card).getByTestId('impacts-note')).toHaveTextContent('Partial');
  });

  it('reads no estimate for a note that is not saved yet', async () => {
    mockStartupConfig.mockReturnValue(config());
    mockImpacts.mockReturnValue({ account: impactsTotals(0.4, 0.15) });
    render(
      <TokenUsage
        index={0}
        conversation={{ conversationId: 'new', endpoint: 'openAI' } as TConversation}
        isSubmitting={false}
      />,
    );
    const card = await openCard();
    expect(mockImpacts).not.toHaveBeenCalled();
    expect(within(card).queryByTestId('impacts-note')).not.toBeInTheDocument();
  });

  it('shows the account total under the balance in settings', () => {
    mockStartupConfig.mockReturnValue(config());
    mockImpacts.mockReturnValue({ account: impactsTotals(0.4, 0.15) });
    const settings = render(<TokenCredits />);
    expect(mockImpacts).toHaveBeenCalledWith(undefined);
    const line = within(settings.container).getByTestId('impacts-account');
    expect(line).toHaveTextContent('All your notes: about 0.4–1 kWh, 150–450 g CO₂e (estimate)');
    const summary = within(settings.container).getByTestId('balance-summary');
    expect(summary.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('shows no account total when balance is off', () => {
    mockStartupConfig.mockReturnValue(config({ balanceEnabled: false }));
    mockImpacts.mockReturnValue({ account: impactsTotals(0.4, 0.15) });
    const settings = render(<TokenCredits />);
    expect(mockImpacts).not.toHaveBeenCalled();
    expect(settings.container).toBeEmptyDOMElement();
  });

  it.each(['credits', 'currency', 'percent'] as const)(
    'shows the same %s reading in the gauge and in settings',
    async (display) => {
      mockStartupConfig.mockReturnValue(config({ display }));
      renderGauge();
      const card = await openCard();
      const gauge = within(card).getByTestId('balance-summary').textContent;

      const settings = render(
        <>
          <TokenCredits />
          <AutoRefill />
        </>,
      );
      const settingsSummary = within(settings.container).getByTestId('balance-summary');
      expect(settingsSummary.textContent).toBe(gauge);

      const refillRow = within(settings.container).queryByText('Refill Amount:');
      if (display === 'percent') {
        expect(refillRow).not.toBeInTheDocument();
        expect(settings.container).not.toHaveTextContent(/5,000,000|\$5\.00/);
      } else {
        const amount = display === 'currency' ? '$5.00' : '5,000,000';
        expect(refillRow?.nextElementSibling).toHaveTextContent(amount);
        expect(gauge).toContain(`+${amount}`);
      }
    },
  );
});
