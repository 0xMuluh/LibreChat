import type { TModelSpec } from 'librechat-data-provider';
import { resolveEphemeralMCPServers, synthesizeToggleToolOptions } from './toggles';
import { TOOL_SELECTION_WILDCARD } from './selection';

const spec = (overrides: Partial<TModelSpec>): TModelSpec =>
  ({
    name: 'spec',
    label: 'Spec',
    preset: { endpoint: 'openai', model: 'gpt-4' },
    ...overrides,
  }) as TModelSpec;

describe('synthesizeToggleToolOptions', () => {
  it('composes the deferral selection with background and intent selections', () => {
    const toolOptions = synthesizeToggleToolOptions({
      modelSpec: spec({ deferLoading: ['web_search'], runInBackground: true }),
    });
    expect(toolOptions).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: true, defer_loading: false },
      web_search: { defer_loading: true },
    });
  });

  it('returns nothing when no selection applies', () => {
    expect(synthesizeToggleToolOptions({ modelSpec: spec({}) })).toBeUndefined();
  });
});

describe('resolveEphemeralMCPServers default servers', () => {
  const getAccessibleMCPServers = async () => ({ notethreads: {}, other: {} });
  const resolve = (specServers?: string[], selected?: string[]) =>
    resolveEphemeralMCPServers({
      selected,
      specServers,
      defaultServers: ['notethreads'],
      userId: 'user-1',
      getAccessibleMCPServers,
    });

  it('attaches the default servers when there is no spec', async () => {
    await expect(resolve(undefined)).resolves.toEqual(['notethreads']);
  });

  it('keeps the default servers through an empty or other picker selection', async () => {
    await expect(resolve(undefined, [])).resolves.toEqual(['notethreads']);
    await expect(resolve([], ['other'])).resolves.toEqual(['other', 'notethreads']);
  });

  it('leaves a spec that lists servers to its own list', async () => {
    await expect(resolve(['other'])).resolves.toEqual(['other']);
  });
});
