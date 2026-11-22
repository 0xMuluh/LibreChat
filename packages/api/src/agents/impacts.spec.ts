import {
  llmImpacts,
  electricityMixes,
  computeLlmImpacts,
  PROVIDER_CONFIG_MAP,
} from '@ecologits/ecologits.js';
import { IMPACT_MODELS, findImpactModel, normalizeImpactModelId } from './impactModels';
import { estimateImpacts } from './impacts';

jest.mock('@ecologits/ecologits.js', () => {
  const actual = jest.requireActual('@ecologits/ecologits.js');
  return { ...actual, llmImpacts: jest.fn(actual.llmImpacts) };
});

const mockLlmImpacts = llmImpacts as jest.MockedFunction<typeof llmImpacts>;
const actualLlmImpacts = jest.requireActual('@ecologits/ecologits.js')
  .llmImpacts as typeof llmImpacts;

/** Every model id the deployment offers that should get an estimate */
const MAPPED_IDS = [
  'anthropic/claude-sonnet-5.5',
  'google/gemini-3.8-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'openai/gpt-6-luna',
  'claude-sonnet-4-6-free',
  'Qwen/Qwen3.5-397B-A17B',
  'Qwen/Qwen3.8-27B',
  'Qwen/Qwen3.8-Flash-Next',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.7-Code',
  'glm-5.2',
];

const UNMAPPED_IDS = [
  'glm-5.3-flash',
  'gemini-4-argon',
  'stealth/space-bunny-alpha',
  'space-bunny-free',
  'deepseek-v4-flash-free',
  'nex-agi/nex-n2.5-mini:free',
  'cohere/north-mini-code:free',
  'gpt-4',
];

describe('normalizeImpactModelId', () => {
  it('drops the provider prefix and reads dots as dashes', () => {
    expect(normalizeImpactModelId('anthropic/claude-sonnet-5.5')).toBe('claude-sonnet-5-5');
    expect(normalizeImpactModelId('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(normalizeImpactModelId('Qwen/Qwen3.5-397B-A17B')).toBe('qwen3-5-397b-a17b');
  });

  it('drops a suffix after a colon', () => {
    expect(normalizeImpactModelId('openai/gpt-6-luna:free')).toBe('gpt-6-luna');
  });
});

describe('findImpactModel', () => {
  it.each(MAPPED_IDS)('maps %s', (model) => {
    expect(findImpactModel(model)).toBeDefined();
  });

  it.each(UNMAPPED_IDS)('has no entry for %s', (model) => {
    expect(findImpactModel(model)).toBeUndefined();
  });

  it('has no entry for a missing id or an inherited property name', () => {
    expect(findImpactModel(undefined)).toBeUndefined();
    expect(findImpactModel('')).toBeUndefined();
    expect(findImpactModel('constructor')).toBeUndefined();
  });

  it('points every catalogue entry at a model EcoLogits knows', () => {
    for (const spec of Object.values(IMPACT_MODELS)) {
      if (spec.kind !== 'catalogue') {
        continue;
      }
      const output = actualLlmImpacts({
        provider: spec.provider,
        modelName: spec.modelName,
        outputTokenCount: 100,
        requestLatency: 5,
      });
      expect(output.hasErrors).toBe(false);
    }
  });

  it('never names the Finnish electricity mix', () => {
    for (const spec of Object.values(IMPACT_MODELS)) {
      expect(spec.kind === 'catalogue' ? spec.zone : undefined).not.toBe('FIN');
    }
  });
});

describe('estimateImpacts', () => {
  beforeEach(() => {
    mockLlmImpacts.mockClear();
  });

  it.each(MAPPED_IDS)('estimates %s as ordered, positive ranges', (model) => {
    const impacts = estimateImpacts({ model, outputTokens: 500, latencySeconds: 8 });
    expect(impacts).not.toBeNull();
    for (const key of ['energy', 'gwp', 'adpe', 'pe', 'wcf'] as const) {
      expect(impacts?.[key].min).toBeGreaterThan(0);
      expect(impacts?.[key].max).toBeGreaterThanOrEqual(impacts?.[key].min ?? Infinity);
    }
    expect(Array.isArray(impacts?.warnings)).toBe(true);
  });

  it.each(UNMAPPED_IDS)('returns null for %s', (model) => {
    expect(estimateImpacts({ model, outputTokens: 500 })).toBeNull();
    expect(mockLlmImpacts).not.toHaveBeenCalled();
  });

  it('returns null for a missing model or an invalid token count', () => {
    expect(estimateImpacts({ model: undefined, outputTokens: 500 })).toBeNull();
    expect(estimateImpacts({ model: 'openai/gpt-6-luna', outputTokens: Number.NaN })).toBeNull();
    expect(estimateImpacts({ model: 'openai/gpt-6-luna', outputTokens: -1 })).toBeNull();
  });

  it('uses the provider defaults for a catalogue model', () => {
    estimateImpacts({ model: 'openai/gpt-6-luna', outputTokens: 500, latencySeconds: 8 });
    expect(mockLlmImpacts).toHaveBeenCalledWith({
      provider: 'openai',
      modelName: 'gpt-6-luna',
      outputTokenCount: 500,
      requestLatency: 8,
      electricityMixZone: undefined,
    });
  });

  it('keeps the catalogue ranges and warning codes', () => {
    const impacts = estimateImpacts({
      model: 'anthropic/claude-sonnet-5.5',
      outputTokens: 500,
      latencySeconds: 8,
    });
    const expected = actualLlmImpacts({
      provider: 'anthropic',
      modelName: 'claude-sonnet-5-5',
      outputTokenCount: 500,
      requestLatency: 8,
    });
    expect(impacts?.energy).toEqual(JSON.parse(JSON.stringify(expected.energy)).value);
    expect(impacts?.energy.max).toBeGreaterThan(impacts?.energy.min ?? Infinity);
    expect(impacts?.warnings).toEqual(expected.warnings?.map((warning) => warning.code));
  });

  it('stores a scalar as a range with equal bounds', () => {
    const scalar = (value: number) => ({ value });
    mockLlmImpacts.mockReturnValueOnce({
      hasErrors: false,
      energy: scalar(0.002),
      gwp: scalar(0.001),
      adpe: scalar(1e-9),
      pe: scalar(0.02),
      wcf: scalar(0.005),
      warnings: null,
    } as unknown as ReturnType<typeof llmImpacts>);

    expect(estimateImpacts({ model: 'openai/gpt-6-luna', outputTokens: 500 })).toEqual({
      energy: { min: 0.002, max: 0.002 },
      gwp: { min: 0.001, max: 0.001 },
      adpe: { min: 1e-9, max: 1e-9 },
      pe: { min: 0.02, max: 0.02 },
      wcf: { min: 0.005, max: 0.005 },
      warnings: [],
    });
  });

  it('returns null when EcoLogits reports an error', () => {
    mockLlmImpacts.mockReturnValueOnce({
      hasErrors: true,
      energy: null,
      gwp: null,
      adpe: null,
      pe: null,
      wcf: null,
      warnings: null,
    } as unknown as ReturnType<typeof llmImpacts>);
    expect(estimateImpacts({ model: 'openai/gpt-6-luna', outputTokens: 500 })).toBeNull();
  });

  it('uses the world mix for the proxied Claude Sonnet 4.6', () => {
    estimateImpacts({ model: 'claude-sonnet-4-6-free', outputTokens: 500, latencySeconds: 8 });
    expect(mockLlmImpacts).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        modelName: 'claude-sonnet-4-6',
        electricityMixZone: 'WOR',
      }),
    );
  });

  it('computes open-weight models from parameter counts and the world mix', () => {
    const mix = electricityMixes.findElectricityMix('WOR');
    const { datacenterPue, datacenterWue } = PROVIDER_CONFIG_MAP.huggingface_hub;
    const expected = computeLlmImpacts({
      modelActiveParameterCount: 17,
      modelTotalParameterCount: 397,
      outputTokenCount: 500,
      requestLatency: 8,
      ifElectricityMixAdpe: mix?.adpe ?? 0,
      ifElectricityMixPe: mix?.pe ?? 0,
      ifElectricityMixGwp: mix?.gwp ?? 0,
      ifElectricityMixWue: mix?.wue ?? 0,
      datacenterPue,
      datacenterWue,
    });

    const impacts = estimateImpacts({
      model: 'Qwen/Qwen3.5-397B-A17B',
      outputTokens: 500,
      latencySeconds: 8,
    });

    expect(mockLlmImpacts).not.toHaveBeenCalled();
    expect(impacts?.energy).toEqual(JSON.parse(JSON.stringify(expected.energy)).value);
    expect(impacts?.gwp).toEqual(JSON.parse(JSON.stringify(expected.gwp)).value);
  });

  it('does not use the catalogue entry for GLM 5.2, which assumes Sweden', () => {
    const impacts = estimateImpacts({ model: 'glm-5.2', outputTokens: 500, latencySeconds: 8 });
    const swedish = actualLlmImpacts({
      provider: 'mistralai',
      modelName: 'glm-5-2',
      outputTokenCount: 500,
      requestLatency: 8,
    });
    expect(mockLlmImpacts).not.toHaveBeenCalled();
    expect(impacts?.gwp.min).toBeGreaterThan(JSON.parse(JSON.stringify(swedish.gwp)).value);
  });

  it('never reads the Finnish electricity mix', () => {
    const findMix = jest.spyOn(electricityMixes, 'findElectricityMix');
    for (const model of MAPPED_IDS) {
      estimateImpacts({ model, outputTokens: 500, latencySeconds: 8 });
    }
    expect(findMix).toHaveBeenCalled();
    expect(findMix.mock.calls.map(([zone]) => zone)).not.toContain('FIN');
    findMix.mockRestore();
  });

  it('lets EcoLogits model the latency when none was measured', () => {
    const timed = estimateImpacts({
      model: 'Qwen/Qwen3.8-27B',
      outputTokens: 500,
      latencySeconds: 0.5,
    });
    const untimed = estimateImpacts({ model: 'Qwen/Qwen3.8-27B', outputTokens: 500 });
    expect(untimed?.energy.max).toBeGreaterThan(timed?.energy.max ?? Infinity);
    expect(Number.isFinite(untimed?.energy.max)).toBe(true);
  });
});
