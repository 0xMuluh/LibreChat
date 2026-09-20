import { ThemeSelector } from '@librechat/client';
import { TStartupConfig } from 'librechat-data-provider';
import { ErrorMessage } from '~/components/Auth/ErrorMessage';
import { TranslationKeys, useLocalize } from '~/hooks';
import SocialLoginRender from './SocialLoginRender';
import { BlinkAnimation } from './BlinkAnimation';
import { Banner } from '../Banners';
import Footer from './Footer';

function AuthLayout({
  children,
  header,
  isFetching,
  startupConfig,
  startupConfigError,
  pathname,
  error,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  isFetching: boolean;
  startupConfig: TStartupConfig | null | undefined;
  startupConfigError: unknown | null | undefined;
  pathname: string;
  error: TranslationKeys | null;
}) {
  const localize = useLocalize();

  const hasStartupConfigError = startupConfigError !== null && startupConfigError !== undefined;
  const DisplayError = () => {
    if (hasStartupConfigError) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize('com_auth_error_login_server')}</ErrorMessage>
        </div>
      );
    } else if (error === 'com_auth_error_invalid_reset_token') {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>
            {localize('com_auth_error_invalid_reset_token')}{' '}
            <a
              className="font-semibold text-accent-primary hover:underline"
              href="/forgot-password"
            >
              {localize('com_auth_click_here')}
            </a>{' '}
            {localize('com_auth_to_try_again')}
          </ErrorMessage>
        </div>
      );
    } else if (error != null && error) {
      return (
        <div className="mx-auto sm:max-w-sm">
          <ErrorMessage>{localize(error)}</ErrorMessage>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-presentation">
      <div className="omicsbase-aurora" aria-hidden="true">
        <div className="omicsbase-aurora-glow" />
        <div className="omicsbase-aurora-vignette" />
      </div>
      <div className="relative z-[1] flex min-h-screen flex-col">
        <Banner />
        <BlinkAnimation active={isFetching}>
          <div className="mt-6 h-10 w-full bg-cover">
            <img
              src="assets/logo.svg"
              className="h-full w-full object-contain"
              alt={localize('com_ui_logo', { 0: startupConfig?.appTitle ?? 'LibreChat' })}
            />
          </div>
        </BlinkAnimation>
        <DisplayError />
        <div className="absolute bottom-0 left-0 md:m-4">
          <ThemeSelector />
        </div>

        <main className="flex flex-grow items-center justify-center">
          <div className="w-authPageWidth overflow-hidden rounded-xl border border-border-light/60 bg-surface-primary/80 px-6 py-4 shadow-sm backdrop-blur-sm sm:max-w-md">
            {!hasStartupConfigError && !isFetching && header && (
              <h1
                className="mb-4 text-center font-display text-3xl font-semibold tracking-tight text-text-primary"
                style={{ userSelect: 'none' }}
              >
                {header}
              </h1>
            )}
            {children}
            {!pathname.includes('2fa') &&
              (pathname.includes('login') || pathname.includes('register')) && (
                <SocialLoginRender startupConfig={startupConfig} />
              )}
          </div>
        </main>
        <Footer startupConfig={startupConfig} />
      </div>
    </div>
  );
}

export default AuthLayout;
