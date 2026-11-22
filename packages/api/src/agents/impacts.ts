import {
  llmImpacts,
  isRangeValue,
  electricityMixes,
  computeLlmImpacts,
  PROVIDER_CONFIG_MAP,
} from '@ecologits/ecologits.js';
import type { ValueOrRange } from '@ecologits/ecologits.js';
import type { ImpactRange, TransactionImpacts } from '@librechat/data-schemas';
import { findImpactModel, WORLD_ZONE } from './impactModels';

export interface EstimateImpactsParams {
  model?: string | null;
  outputTokens: number;
  /** Measured duration of the model call; without it EcoLogits models the latency */
  latencySeconds?: number | null;
}

/** Energy in kWh, gwp in kgCO2eq, adpe in kgSbeq, pe in MJ, wcf in litres */
export type ImpactsEstimate = Required<
  Pick<TransactionImpacts, 'energy' | 'gwp' | 'adpe' | 'pe' | 'wcf' | 'warnings'>
>;

const toRange = (value: ValueOrRange): ImpactRange =>
  isRangeValue(value) ? { min: value.min, max: value.max } : { min: value, max: value };

/**
 * Estimates the environmental impacts of one model call with EcoLogits.
 * Returns `null` when the model has no entry in the mapping table or EcoLogits
 * cannot estimate it.
 */
export function estimateImpacts({
  model,
  outputTokens,
  latencySeconds,
}: EstimateImpactsParams): ImpactsEstimate | null {
  const spec = findImpactModel(model);
  if (spec == null || !Number.isFinite(outputTokens) || outputTokens < 0) {
    return null;
  }
  const requestLatency =
    latencySeconds != null && Number.isFinite(latencySeconds) && latencySeconds > 0
      ? latencySeconds
      : Number.POSITIVE_INFINITY;

  if (spec.kind === 'catalogue') {
    const output = llmImpacts({
      provider: spec.provider,
      modelName: spec.modelName,
      outputTokenCount: outputTokens,
      requestLatency,
      electricityMixZone: spec.zone,
    });
    const { energy, gwp, adpe, pe, wcf } = output;
    if (output.hasErrors || !energy || !gwp || !adpe || !pe || !wcf) {
      return null;
    }
    return {
      energy: toRange(energy.value),
      gwp: toRange(gwp.value),
      adpe: toRange(adpe.value),
      pe: toRange(pe.value),
      wcf: toRange(wcf.value),
      warnings: (output.warnings ?? []).map((warning) => warning.code),
    };
  }

  const mix = electricityMixes.findElectricityMix(WORLD_ZONE);
  if (mix == null) {
    return null;
  }
  const { datacenterPue, datacenterWue } = PROVIDER_CONFIG_MAP.huggingface_hub;
  const impacts = computeLlmImpacts({
    modelActiveParameterCount: spec.active,
    modelTotalParameterCount: spec.total,
    outputTokenCount: outputTokens,
    requestLatency,
    ifElectricityMixAdpe: mix.adpe,
    ifElectricityMixPe: mix.pe,
    ifElectricityMixGwp: mix.gwp,
    ifElectricityMixWue: mix.wue,
    datacenterPue,
    datacenterWue,
  });
  return {
    energy: toRange(impacts.energy.value),
    gwp: toRange(impacts.gwp.value),
    adpe: toRange(impacts.adpe.value),
    pe: toRange(impacts.pe.value),
    wcf: toRange(impacts.wcf.value),
    warnings: mix.warnings.map((warning) => warning.code),
  };
}
