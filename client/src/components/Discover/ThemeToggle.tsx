import { useContext } from 'react';
import { Moon, Sun } from 'lucide-react';
import { ThemeContext } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** Light/dark switch for the signed-out page, using the app's own theme setting. */
export default function ThemeToggle() {
  const localize = useLocalize();
  const { resolvedMode, setTheme } = useContext(ThemeContext);
  const dark = resolvedMode === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={localize('com_discover_toggle_theme')}
      title={localize('com_discover_toggle_theme')}
      className="flex size-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover"
    >
      {dark ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
