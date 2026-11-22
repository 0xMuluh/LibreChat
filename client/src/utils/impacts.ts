import type { TImpactRange } from 'librechat-data-provider';

export type ImpactKind = 'energy' | 'gwp';

/** Smallest to largest; totals arrive in the largest (kWh, kg CO₂e) */
const UNITS: Record<ImpactKind, [string, string, string]> = {
  energy: ['mWh', 'Wh', 'kWh'],
  gwp: ['mg', 'g', 'kg'],
};

/** One significant figure below 10, two from there on: 2, 24, 240 */
function roundEstimate(value: number): string {
  if (!Number.isFinite(value) || value < 0.005) {
    return '0';
  }
  return String(Number(value.toPrecision(value >= 10 ? 2 : 1)));
}

/**
 * Formats an estimate range in the unit that suits its upper bound, for
 * example `2–6 Wh` or `300–900 mg`. A range whose bounds round to the same
 * figure reads as that figure alone.
 */
export function formatImpactRange({ min, max }: TImpactRange, kind: ImpactKind): string {
  const [small, medium, large] = UNITS[kind];
  let factor = 1_000_000;
  let unit = small;
  if (max >= 1) {
    factor = 1;
    unit = large;
  } else if (max >= 0.001) {
    factor = 1000;
    unit = medium;
  }
  const low = roundEstimate(min * factor);
  const high = roundEstimate(max * factor);
  return low === high ? `${high} ${unit}` : `${low}–${high} ${unit}`;
}
