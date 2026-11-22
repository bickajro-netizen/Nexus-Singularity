import { describe, it, expect } from 'vitest';
import { computeYerkesDodsonMultiplier, computeDeltaPartialXp, evaluateRecoveryShield } from './xp';

describe('computeYerkesDodsonMultiplier', () => {
  it('stays within [0.6, 1.35] for out-of-range inputs', () => {
    for (const E of [-10, 0, 72, 100, 200]) {
      const m = computeYerkesDodsonMultiplier(E);
      expect(m).toBeGreaterThanOrEqual(0.6);
      expect(m).toBeLessThanOrEqual(1.35);
    }
  });

  it('peaks at 1.35 for E=72 and falls back to 0.6 at extremes', () => {
    expect(computeYerkesDodsonMultiplier(72)).toBeCloseTo(1.35, 6);
    // E=0 clamps to range but gaussian tail keeps a small lift above the 0.6 asymptote
    expect(computeYerkesDodsonMultiplier(0)).toBeCloseTo(0.6 + 0.75 * Math.exp(-(72 ** 2) / (2 * 22 ** 2)), 6);
    expect(computeYerkesDodsonMultiplier(100)).toBeCloseTo(0.6 + 0.75 * Math.exp(-(28 ** 2) / (2 * 22 ** 2)), 6);
  });
});

describe('computeDeltaPartialXp', () => {
  const base = { highWatermarkPct: 0, xpBase: 100, priorityLevel: 'medium' as const, comboChainCount: 0, attemptsCount: 0 };

  it('returns 0 on regression', () => {
    expect(computeDeltaPartialXp(80, 30, base)).toBe(0);
  });

  it('returns 0 when progress stays below the high-watermark', () => {
    expect(computeDeltaPartialXp(20, 45, { ...base, highWatermarkPct: 60 })).toBe(0);
  });

  it('awards only the increment above the watermark (no re-award)', () => {
    const xp = computeDeltaPartialXp(30, 55, { ...base, highWatermarkPct: 40 });
    expect(xp).toBeCloseTo(15 * 100, 6);
  });

  it('floor applies to the progress delta, not the multiplier (blueprint formula)', () => {
    const xp = computeDeltaPartialXp(0, 1, { ...base, attemptsCount: 1000 });
    // max(0.25, delta=1) = 1 → 1 * xpBase * priority * combo * diminishing
    expect(xp).toBeCloseTo(1 * 100 * (1 / (1 + 0.35 * 1000)), 6);
  });

  it('floor kicks in for sub-floor deltas', () => {
    const xp = computeDeltaPartialXp(0, 0.1, { ...base, attemptsCount: 0 });
    expect(xp).toBeCloseTo(0.25 * 100, 6);
  });
});

describe('evaluateRecoveryShield', () => {
  it('activates on a single reason without quiet mode', () => {
    const s = evaluateRecoveryShield({ sleepDebtHours: 0, activeIllnessFlag: true, jointPainFlag: false });
    expect(s.active).toBe(true);
    expect(s.reasons).toEqual(['illness']);
    expect(s.quietModeSuggested).toBe(false);
    expect(s.freezeStreak).toBe(true);
  });

  it('suggests quiet mode from two or more reasons', () => {
    const s = evaluateRecoveryShield({ sleepDebtHours: 5, activeIllnessFlag: false, jointPainFlag: true });
    expect(s.reasons).toEqual(expect.arrayContaining(['sleep_debt', 'joint_pain']));
    expect(s.quietModeSuggested).toBe(true);
    expect(s.active).toBe(true);
  });

  it('stays off when healthy', () => {
    const s = evaluateRecoveryShield({ sleepDebtHours: 1, activeIllnessFlag: false, jointPainFlag: false, soreness: 2 });
    expect(s.active).toBe(false);
    expect(s.reasons).toEqual([]);
  });
});
