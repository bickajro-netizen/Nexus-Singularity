// Worker protocol per blueprint §WORKER PROTOCOL. Worker NEVER opens IDB (single-writer rule).

import type { EnergyBatteries, PriorityLevel, TimestampMs, DateKey } from '../types';

export interface XpFormulaConfigLegacy {
  priorityMultipliers: { low: number; medium: number; high: number; critical: number };
  comboStepPerChain: number;
  comboMaxMultiplier: number;
  diminishingDecayLambda: number;
  diminishingFloor: number;
  yerkesOptimumE: number;
  yerkesSigma: number;
  parentRollupCompletionBonusRatio: number;
}

export interface GraphComputeNode {
  id: string;
  parentId?: string | null;
  progressPct: number;
  highWatermarkPct: number;
  xpBase: number;
  priority: PriorityLevel;
  blockedBy: string[];
  skillIds: string[];
  completed: boolean;
}

export interface GraphNodeSnapshot {
  snapshotRevision: number;
  nodes: Record<string, GraphComputeNode>;
  energyBatteries: EnergyBatteries;
  recoveryShieldActive: boolean;
  comboChainCount: number;
  dailyNodeActionCounts: Record<string, number>;
  characterLevel: number;
  skillLevels: Record<string, number>;
  timestamp: TimestampMs;
}

export interface ComputeGraphAndXpRequest {
  type: 'COMPUTE_GRAPH_AND_XP';
  requestId: string;
  snapshotRevision: number;
  dateKey: DateKey;
  nowMs: TimestampMs;
  nodes: Record<string, GraphComputeNode>;
  changedNodeIds: string[];
  energyBatteries: EnergyBatteries;
  recoveryShieldActive: boolean;
  comboChainCount: number;
  dailyNodeActionCounts: Record<string, number>;
  characterLevel: number;
  skillLevels: Record<string, number>;
  formulaConfig: XpFormulaConfigLegacy;
}

export interface ShieldSuggestion { active: boolean; reasons: string[]; quietModeSuggested: boolean }

export interface GraphAndXpResult {
  type: 'GRAPH_AND_XP_RESULT';
  requestId: string;
  snapshotRevision: number;
  rolledUpDiffs: Record<string, number>;
  xpDeltas: Record<string, number>;
  unlockedIds: string[];
  cycleIds: string[];
  levelUpDelta: number;
  skillDeltas: Record<string, number>;
  shieldSuggestion: ShieldSuggestion;
}
