// XP math per blueprint §MATH ENGINE: yerkes [0.6,1.35], high-watermark delta, recovery shield.

import type { PriorityLevel } from '../types';

export interface XpFormulaConfig {
  priorityMultipliers: Record<PriorityLevel, number>;
  comboStepPerChain: number;
  comboMaxMultiplier: number;
  diminishingDecayLambda: number;
  diminishingFloor: number;
  yerkesOptimumE: number;
  yerkesSigma: number;
  parentRollupCompletionBonusRatio: number;
}

export const DEFAULT_XP_CONFIG: XpFormulaConfig = {
  priorityMultipliers: { low: 0.85, medium: 1.0, high: 1.25, critical: 1.6 },
  comboStepPerChain: 0.08,
  comboMaxMultiplier: 1.40,
  diminishingDecayLambda: 0.35,
  diminishingFloor: 0.25,
  yerkesOptimumE: 72,
  yerkesSigma: 22,
  parentRollupCompletionBonusRatio: 0.15,
};

export interface DeltaXpInput {
  highWatermarkPct: number;
  xpBase: number;
  priorityLevel: PriorityLevel;
  comboChainCount: number;
  attemptsCount: number;
}

export function computeYerkesDodsonMultiplier(E: number): number {
  const clamped = Math.min(100, Math.max(0, E));
  const sigma = DEFAULT_XP_CONFIG.yerkesSigma;
  const optimum = DEFAULT_XP_CONFIG.yerkesOptimumE;
  return 0.6 + 0.75 * Math.exp(-((clamped - optimum) ** 2) / (2 * sigma ** 2));
}

export function computeDeltaPartialXp(oldProgressPct: number, newProgressPct: number, input: DeltaXpInput): number {
  const cfg = DEFAULT_XP_CONFIG;
  const oldHigh = Math.max(oldProgressPct, input.highWatermarkPct);
  const newHigh = Math.max(newProgressPct, input.highWatermarkPct);
  const progressDelta = newHigh - oldHigh;
  if (progressDelta <= 0) return 0;
  const priorityMult = cfg.priorityMultipliers[input.priorityLevel] ?? 1.0;
  const comboMult = Math.min(1 + input.comboChainCount * cfg.comboStepPerChain, cfg.comboMaxMultiplier);
  const diminishing = 1 / (1 + cfg.diminishingDecayLambda * input.attemptsCount);
  const effectiveDelta = Math.max(cfg.diminishingFloor, progressDelta) * input.xpBase * priorityMult * comboMult * diminishing;
  return effectiveDelta;
}

export interface ShieldInput {
  sleepDebtHours: number;
  activeIllnessFlag: boolean;
  jointPainFlag: boolean;
  soreness?: number;
  tonsilPainFlag?: boolean;
}

export interface ShieldEvaluation {
  active: boolean;
  reasons: string[];
  quietModeSuggested: boolean;
  freezeStreak: boolean;
}

export function evaluateRecoveryShield(input: ShieldInput): ShieldEvaluation {
  const reasons: string[] = [];
  if (input.sleepDebtHours >= 4) reasons.push('sleep_debt');
  if (input.activeIllnessFlag) reasons.push('illness');
  if (input.jointPainFlag) reasons.push('joint_pain');
  if ((input.soreness ?? 0) >= 4) reasons.push('high_soreness');
  if (input.tonsilPainFlag) reasons.push('tonsil_pain');
  return {
    active: reasons.length > 0,
    reasons,
    quietModeSuggested: reasons.length >= 2,
    freezeStreak: reasons.includes('illness') || reasons.includes('joint_pain'),
  };
}
