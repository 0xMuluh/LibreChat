import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { request } from 'librechat-data-provider';
import { Server, Clock, Square, Loader2, CircleCheck, ExternalLink } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type SessionState = 'none' | 'preparing' | 'queued' | 'starting' | 'running' | 'ended' | 'unknown';

interface SessionView {
  state: SessionState;
  project?: string;
  endsAt?: number;
  message?: string;
}

type Field = 'project' | 'cores' | 'memory' | 'hours' | 'token';
const FIELDS: Field[] = ['project', 'cores', 'memory', 'hours', 'token'];

const whole = (v: string, lo: number, hi: number) => /^\d+$/.test(v) && +v >= lo && +v <= hi;
const VALID: Record<Field, (v: string) => boolean> = {
  project: (v) => /^project_\d{7}$/.test(v.trim()),
  cores: (v) => whole(v, 1, 8),
  memory: (v) => whole(v, 2, 64),
  hours: (v) => whole(v, 1, 36),
  token: (v) => v.trim().length > 0,
};
const ERROR_KEY: Record<Field, TranslationKeys> = {
  project: 'com_roihu_err_project',
  cores: 'com_roihu_err_cores',
  memory: 'com_roihu_err_memory',
  hours: 'com_roihu_err_hours',
  token: 'com_roihu_err_token',
};

const ACTIVE: SessionState[] = ['preparing', 'queued', 'starting', 'running', 'unknown'];
const POLL_MS = 10_000;

/** The server's error text for the user, if any. */
function serverError(e: unknown): string | undefined {
  return (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
}

const inputClass =
  'w-full rounded-lg border border-border-medium bg-surface-primary px-3 py-2 text-sm text-text-primary ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-control aria-[invalid=true]:border-destructive';

interface TextFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}

function TextField({ id, label, hint, error, inputRef, ...input }: TextFieldProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="text-text-primary mb-1 block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        ref={inputRef}
        className={inputClass}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={`${id}-hint ${id}-err`}
        {...input}
      />
      {hint != null && (
        <p id={`${id}-hint`} className="text-text-secondary mt-1 text-xs leading-relaxed">
          {hint}
        </p>
      )}
      <p id={`${id}-err`} className="text-text-destructive mt-1 text-xs" hidden={!error}>
        {error}
      </p>
    </div>
  );
}

interface StatusCardProps {
  icon: LucideIcon;
  spin?: boolean;
  title: string;
  body: string;
  children?: React.ReactNode;
}

function StatusCard({ icon: Icon, spin, title, body, children }: StatusCardProps) {
  return (
    <div className="border-border-light flex items-start gap-3 rounded-xl border p-4">
      <Icon
        className={cn('text-text-secondary mt-0.5 h-5 w-5 shrink-0', spin && 'animate-spin')}
        aria-hidden={true}
      />
      <div className="flex-1">
        <p className="text-text-primary text-sm font-medium">{title}</p>
        <p className="text-text-secondary mt-0.5 text-sm">{body}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * Reports on Roihu: start the user's own Reports agent as a job in their CSC project, follow
 * it until it runs, open it and stop it. The session belongs to the user, not to one project.
 */
export default function RoihuSessionCard() {
  const uid = useId();
  const localize = useLocalize();
  const [session, setSession] = useState<SessionView | null>(null);
  const [values, setValues] = useState<Record<Field, string>>({
    project: '',
    cores: '2',
    memory: '8',
    hours: '4',
    token: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const refs = useRef<Partial<Record<Field, HTMLInputElement | null>>>({});
  const openRef = useRef<HTMLButtonElement | null>(null);
  const lastState = useRef<SessionState | null>(null);

  const generic = localize('com_roihu_err_generic');

  const refresh = useCallback(async () => {
    try {
      setSession(await request.get<SessionView>('/api/roihu/session'));
    } catch (e) {
      setSession((s) => s ?? { state: 'none' });
      setNotice(serverError(e) ?? generic);
    }
  }, [generic]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session || !ACTIVE.includes(session.state)) {
      return;
    }
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [session, refresh]);

  useEffect(() => {
    if (session?.state === 'running' && lastState.current !== 'running') {
      openRef.current?.focus();
    }
    lastState.current = session?.state ?? null;
  }, [session?.state]);

  const setField = (field: Field) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((er) => ({ ...er, [field]: '' }));
  };

  const launch = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice('');
    const found: Partial<Record<Field, string>> = {};
    for (const f of FIELDS) {
      if (!VALID[f](values[f])) {
        found[f] = localize(ERROR_KEY[f]);
      }
    }
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    setBusy(true);
    try {
      const view = (await request.post('/api/roihu/session', {
        project: values.project.trim(),
        cores: Number(values.cores),
        memory: Number(values.memory),
        hours: Number(values.hours),
        token: values.token.trim(),
      })) as SessionView;
      setValues((v) => ({ ...v, token: '' }));
      setSession(view);
    } catch (err) {
      setNotice(serverError(err) ?? generic);
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    const tab = window.open('', '_blank');
    try {
      const { url } = (await request.post('/api/roihu/session/open')) as { url: string };
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (err) {
      tab?.close();
      setNotice(serverError(err) ?? generic);
    }
  };

  const stop = async () => {
    if (!window.confirm(localize('com_roihu_stop_confirm'))) {
      return;
    }
    setBusy(true);
    try {
      setSession(await request.delete<SessionView>('/api/roihu/session'));
    } catch (err) {
      setNotice(serverError(err) ?? generic);
    } finally {
      setBusy(false);
    }
  };

  const until = session?.endsAt
    ? new Date(session.endsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
  const active = session != null && ACTIVE.includes(session.state);
  const stopButton = (
    <Button type="button" variant="outline" size="sm" onClick={stop} disabled={busy}>
      <Square className="h-3.5 w-3.5" aria-hidden={true} />
      {localize('com_roihu_stop')}
    </Button>
  );

  let status: React.ReactNode = null;
  if (session === null) {
    status = <p className="text-text-secondary text-sm">{localize('com_roihu_checking')}</p>;
  } else if (session.state === 'preparing') {
    status = (
      <StatusCard
        icon={Loader2}
        spin
        title={localize('com_roihu_preparing_title', { 0: session.project ?? '' })}
        body={localize('com_roihu_preparing_body')}
      >
        <div className="mt-3">{stopButton}</div>
      </StatusCard>
    );
  } else if (session.state === 'queued') {
    status = (
      <StatusCard
        icon={Clock}
        title={localize('com_roihu_queued_title')}
        body={localize('com_roihu_queued_body')}
      >
        <div className="mt-3">{stopButton}</div>
      </StatusCard>
    );
  } else if (session.state === 'starting') {
    status = (
      <StatusCard
        icon={Loader2}
        spin
        title={localize('com_roihu_starting_title')}
        body={localize('com_roihu_starting_body')}
      >
        <div className="mt-3">{stopButton}</div>
      </StatusCard>
    );
  } else if (session.state === 'running') {
    status = (
      <StatusCard
        icon={CircleCheck}
        title={localize('com_roihu_running_title')}
        body={
          until
            ? localize('com_roihu_running_body', { 0: session.project ?? '', 1: until })
            : localize('com_roihu_running_body_no_end', { 0: session.project ?? '' })
        }
      >
        {session.message && <p className="text-text-secondary mt-2 text-sm">{session.message}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button ref={openRef} type="button" size="sm" onClick={open}>
            <ExternalLink className="h-3.5 w-3.5" aria-hidden={true} />
            {localize('com_roihu_open')}
          </Button>
          {stopButton}
        </div>
      </StatusCard>
    );
  } else if (session.state === 'unknown') {
    status = (
      <StatusCard
        icon={Loader2}
        spin
        title={localize('com_roihu_unknown_title')}
        body={session.message ?? localize('com_roihu_unknown_body')}
      >
        <div className="mt-3">{stopButton}</div>
      </StatusCard>
    );
  } else if (session.state === 'ended' && session.message) {
    status = <p className="text-text-secondary mb-4 text-sm">{session.message}</p>;
  }

  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="border-border-light bg-surface-primary mx-auto w-full max-w-xl rounded-2xl border p-6 text-left shadow-md"
    >
      <div className="mb-1 flex items-center gap-2">
        <Server className="text-text-secondary h-5 w-5" aria-hidden={true} />
        <h2 id={`${uid}-title`} className="text-text-primary text-base font-semibold">
          {localize('com_roihu_title')}
        </h2>
      </div>
      <p className="text-text-secondary mb-5 text-sm">{localize('com_roihu_intro')}</p>

      <div role="status" aria-live="polite">
        {status}
        {notice && (
          <p className="text-text-destructive mb-4 text-sm" role="alert">
            {notice}
          </p>
        )}
      </div>

      {session != null && !active && (
        <form noValidate onSubmit={launch} aria-describedby={`${uid}-required`}>
          <p id={`${uid}-required`} className="text-text-secondary mb-3 text-xs">
            {localize('com_roihu_required')}
          </p>
          <TextField
            id={`${uid}-project`}
            label={localize('com_roihu_project')}
            placeholder="project_1234567"
            autoComplete="off"
            spellCheck={false}
            value={values.project}
            onChange={setField('project')}
            error={errors.project}
            inputRef={(el) => (refs.current.project = el)}
            hint={localize('com_roihu_project_hint')}
          />
          <fieldset className="mb-1">
            <legend className="text-text-primary mb-2 text-sm font-medium">
              {localize('com_roihu_resources')}
            </legend>
            <div className="grid grid-cols-3 gap-3">
              <TextField
                id={`${uid}-cores`}
                label={localize('com_roihu_cores')}
                type="number"
                inputMode="numeric"
                min={1}
                max={8}
                step={1}
                value={values.cores}
                onChange={setField('cores')}
                error={errors.cores}
                inputRef={(el) => (refs.current.cores = el)}
                hint={localize('com_roihu_cores_hint')}
              />
              <TextField
                id={`${uid}-memory`}
                label={localize('com_roihu_memory')}
                type="number"
                inputMode="numeric"
                min={2}
                max={64}
                step={1}
                value={values.memory}
                onChange={setField('memory')}
                error={errors.memory}
                inputRef={(el) => (refs.current.memory = el)}
                hint={localize('com_roihu_memory_hint')}
              />
              <TextField
                id={`${uid}-hours`}
                label={localize('com_roihu_hours')}
                type="number"
                inputMode="numeric"
                min={1}
                max={36}
                step={1}
                value={values.hours}
                onChange={setField('hours')}
                error={errors.hours}
                inputRef={(el) => (refs.current.hours = el)}
                hint={localize('com_roihu_hours_hint')}
              />
            </div>
          </fieldset>
          <TextField
            id={`${uid}-token`}
            label={localize('com_roihu_token')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={localize('com_roihu_token_placeholder')}
            value={values.token}
            onChange={setField('token')}
            error={errors.token}
            inputRef={(el) => (refs.current.token = el)}
            hint={
              <>
                {localize('com_roihu_token_hint')}{' '}
                <a
                  href="https://my.csc.fi/firecrest-token"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-visible:ring-focus-control underline focus-visible:ring-2 focus-visible:outline-none"
                >
                  {localize('com_roihu_token_link')}
                </a>
              </>
            }
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden={true} />}
              {localize('com_roihu_launch')}
            </Button>
            <span className="text-text-secondary text-xs">{localize('com_roihu_keys_note')}</span>
          </div>
        </form>
      )}
    </section>
  );
}
