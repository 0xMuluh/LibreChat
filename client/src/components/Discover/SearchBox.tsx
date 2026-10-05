import { useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { useLocalize } from '~/hooks';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

/** Search over examples and datasets; "/" focuses it from anywhere on the page. */
export default function SearchBox({ value, onChange }: Props) {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <label className="flex w-full max-w-sm items-center gap-2 rounded-lg border border-border-light bg-surface-primary px-2.5 py-1.5 text-text-tertiary focus-within:border-border-heavy">
      <Search className="size-4 flex-none" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={localize('com_discover_search')}
        aria-label={localize('com_discover_search')}
        className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <kbd className="rounded border border-border-medium px-1.5 font-mono text-[11px]">/</kbd>
    </label>
  );
}
