/**
 * Which EcoLogits inputs each of our model ids uses for the energy estimate.
 *
 * - `catalogue`: the model is in the EcoLogits catalogue; its provider defaults
 *   (data centre, electricity mix) apply unless `zone` overrides the mix.
 * - `parameters`: open-weight model served by an inference provider; parameter
 *   counts (in billions) are passed explicitly with the world electricity mix.
 *
 * Models that are not listed get no estimate.
 */
export type ImpactModelSpec =
  | { kind: 'catalogue'; provider: string; modelName: string; zone?: string }
  | { kind: 'parameters'; total: number; active: number };

/** World average electricity mix, used whenever the hosting region is unknown */
export const WORLD_ZONE = 'WOR';

const dense = (parameters: number): ImpactModelSpec => ({
  kind: 'parameters',
  total: parameters,
  active: parameters,
});

const moe = (total: number, active: number): ImpactModelSpec => ({
  kind: 'parameters',
  total,
  active,
});

/** Keyed on the normalised model id, see {@link normalizeImpactModelId} */
export const IMPACT_MODELS: Readonly<Record<string, ImpactModelSpec>> = {
  'claude-sonnet-5-5': {
    kind: 'catalogue',
    provider: 'anthropic',
    modelName: 'claude-sonnet-5-5',
  },
  /** Served through a third-party proxy, so the hosting region is unknown */
  'claude-sonnet-4-6-free': {
    kind: 'catalogue',
    provider: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    zone: WORLD_ZONE,
  },
  'gemini-3-8-flash': {
    kind: 'catalogue',
    provider: 'google_genai',
    modelName: 'gemini-3.8-flash',
  },
  'gemini-3-7-flash': {
    kind: 'catalogue',
    provider: 'google_genai',
    modelName: 'gemini-3.7-flash',
  },
  'gemini-3-1-pro-preview': {
    kind: 'catalogue',
    provider: 'google_genai',
    modelName: 'gemini-3.1-pro-preview',
  },
  'gpt-6-luna': { kind: 'catalogue', provider: 'openai', modelName: 'gpt-6-luna' },
  'qwen3-5-397b-a17b': moe(397, 17),
  'qwen3-8-27b': dense(27),
  'qwen3-8-flash-next': moe(180, 6),
  'kimi-k2-6': moe(1000, 32),
  'kimi-k2-7-code': moe(1000, 32),
  /** Explicit parameters: the catalogue entry assumes a Swedish data centre */
  'glm-5-2': moe(744, 40),
};

/**
 * Reduces a model id to the form the table is keyed on: lower case, without a
 * `provider/` prefix or a `:free`-style suffix, and with dots as dashes.
 * `anthropic/claude-sonnet-5.5` and `claude-sonnet-5-5` give the same key.
 */
export function normalizeImpactModelId(model: string): string {
  const id = model.trim().toLowerCase();
  const [withoutSuffix = ''] = id.split(':');
  const name = withoutSuffix.slice(withoutSuffix.lastIndexOf('/') + 1);
  return name.replace(/\./g, '-');
}

export function findImpactModel(model?: string | null): ImpactModelSpec | undefined {
  if (typeof model !== 'string' || model === '') {
    return undefined;
  }
  const key = normalizeImpactModelId(model);
  return Object.prototype.hasOwnProperty.call(IMPACT_MODELS, key) ? IMPACT_MODELS[key] : undefined;
}
