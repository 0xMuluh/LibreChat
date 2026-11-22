import { formatImpactRange } from './impacts';

describe('formatImpactRange', () => {
  it('reads kWh as Wh and kg as g at everyday sizes', () => {
    expect(formatImpactRange({ min: 0.0021, max: 0.0063 }, 'energy')).toBe('2–6 Wh');
    expect(formatImpactRange({ min: 0.0011, max: 0.0029 }, 'gwp')).toBe('1–3 g');
  });

  it('keeps two significant figures from ten upwards', () => {
    expect(formatImpactRange({ min: 0.0123, max: 0.0456 }, 'energy')).toBe('12–46 Wh');
    expect(formatImpactRange({ min: 0.123, max: 0.456 }, 'gwp')).toBe('120–460 g');
  });

  it('uses the small unit when even the upper bound is tiny', () => {
    expect(formatImpactRange({ min: 0.0000004, max: 0.0000009 }, 'energy')).toBe('0.4–0.9 mWh');
    expect(formatImpactRange({ min: 0.0003, max: 0.0008 }, 'gwp')).toBe('300–800 mg');
  });

  it('uses the large unit for an account that has grown', () => {
    expect(formatImpactRange({ min: 0.4, max: 1.2 }, 'energy')).toBe('0.4–1 kWh');
    expect(formatImpactRange({ min: 2.2, max: 31 }, 'gwp')).toBe('2–31 kg');
  });

  it('picks the unit from the upper bound', () => {
    expect(formatImpactRange({ min: 0.0002, max: 0.003 }, 'energy')).toBe('0.2–3 Wh');
  });

  it('shows one figure when both bounds round to it', () => {
    expect(formatImpactRange({ min: 0.003, max: 0.003 }, 'energy')).toBe('3 Wh');
    expect(formatImpactRange({ min: 0.0029, max: 0.0031 }, 'gwp')).toBe('3 g');
  });

  it('shows zero for nothing', () => {
    expect(formatImpactRange({ min: 0, max: 0 }, 'energy')).toBe('0 mWh');
  });
});
