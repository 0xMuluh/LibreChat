import type { TImpactsTotals } from 'librechat-data-provider';
import { formatImpactRange } from '~/utils/impacts';
import useLocalize from '~/hooks/useLocalize';
import cn from '~/utils/cn';

export const IMPACTS_DOCS_URL = 'https://omicsbase.utu.fi/docs/start/energy.html';

interface ImpactsProps {
  totals?: TImpactsTotals;
  /** One note, or every note of the account */
  scope: 'note' | 'account';
  className?: string;
}

/**
 * The estimated energy use and emissions of the model calls behind a note or an
 * account. Renders nothing until there is an estimate or a model without one.
 */
export default function Impacts({ totals, scope, className }: ImpactsProps) {
  const localize = useLocalize();
  if (totals == null) {
    return null;
  }
  const estimated = totals.energy.max > 0;
  if (!estimated && !totals.partial) {
    return null;
  }

  return (
    <p className={cn('text-text-secondary text-xs', className)} data-testid={`impacts-${scope}`}>
      {estimated
        ? localize(scope === 'note' ? 'com_ui_impacts_note' : 'com_ui_impacts_account', {
            0: formatImpactRange(totals.energy, 'energy'),
            1: formatImpactRange(totals.gwp, 'gwp'),
          })
        : localize('com_ui_impacts_none')}
      {estimated && totals.partial && <> {localize('com_ui_impacts_partial')}</>}{' '}
      <a
        href={IMPACTS_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="hover:text-text-primary underline"
      >
        {localize('com_ui_impacts_learn_more')}
      </a>
    </p>
  );
}
