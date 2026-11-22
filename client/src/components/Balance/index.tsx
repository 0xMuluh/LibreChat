import { useGetImpactsQuery } from '~/data-provider';
import useBalanceSummary from '~/hooks/useBalanceSummary';
import Impacts from './Impacts';
import Summary from './Summary';

interface BalanceProps {
  className?: string;
  /** Also show the account's energy estimate under the balance */
  showImpacts?: boolean;
}

/** The user's balance, or nothing when the deployment does not meter credits. */
export default function Balance({ className, showImpacts = false }: BalanceProps) {
  const { enabled, state, currency } = useBalanceSummary();
  const { data: impacts } = useGetImpactsQuery(undefined, { enabled: enabled && showImpacts });
  if (!enabled) {
    return null;
  }
  return (
    <>
      <Summary state={state} currency={currency} className={className} />
      {showImpacts && <Impacts totals={impacts?.account} scope="account" className="mt-2" />}
    </>
  );
}

export { Summary };
