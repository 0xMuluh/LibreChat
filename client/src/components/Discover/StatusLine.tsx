import { useLocalize } from '~/hooks';

type Props = {
  text: string;
  /** After a load error: draws a Try again button that calls this. */
  onRetry?: () => void;
};

/** One centred line for a list that is loading, empty or failed to load. */
export default function StatusLine({ text, onRetry }: Props) {
  const localize = useLocalize();
  return (
    <div className="flex flex-col items-center gap-3 py-7 text-center">
      <p className="text-text-tertiary text-sm" role="status">
        {text}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="border-border-medium text-text-primary hover:bg-surface-hover rounded-full border px-4 py-1.5 text-sm font-medium"
        >
          {localize('com_discover_try_again')}
        </button>
      )}
    </div>
  );
}
