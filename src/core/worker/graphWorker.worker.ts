// Compute worker: GRAPH_AND_XP over node graph. Never touches IDB.

import type { ComputeGraphAndXpRequest, GraphAndXpResult, GraphComputeNode } from './protocol';
import { computeYerkesDodsonMultiplier, computeDeltaPartialXp, evaluateRecoveryShield } from '../math/xp';

function findCycles(nodes: Record<string, GraphComputeNode>): string[] {
  const color = new Map<string, 0 | 1 | 2>();
  const inCycle = new Set<string>();
  for (const id of Object.keys(nodes)) color.set(id, 0);

  const visit = (id: string, stack: string[]): void => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of nodes[id]?.blockedBy ?? []) {
      if (!nodes[dep]) continue;
      const c = color.get(dep) ?? 0;
      if (c === 1) {
        const start = stack.indexOf(dep);
        for (const cycleId of stack.slice(start === -1 ? 0 : start)) inCycle.add(cycleId);
        inCycle.add(dep);
      } else if (c === 0) {
        visit(dep, stack);
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const id of Object.keys(nodes)) {
    if (color.get(id) === 0) visit(id, []);
  }
  return [...inCycle];
}

function compute(request: ComputeGraphAndXpRequest): GraphAndXpResult {
  const { nodes, changedNodeIds, energyBatteries, comboChainCount, dailyNodeActionCounts, characterLevel, formulaConfig } = request;
  const cycleIds = findCycles(nodes);
  const cycleSet = new Set(cycleIds);

  const xpDeltas: Record<string, number> = {};
  const unlockedIds: string[] = [];
  let totalXp = 0;

  const yerkes = computeYerkesDodsonMultiplier(energyBatteries.averageEnergy);

  for (const id of changedNodeIds) {
    const node = nodes[id];
    if (!node || cycleSet.has(id)) continue;
    const delta = computeDeltaPartialXp(node.highWatermarkPct, node.progressPct, {
      highWatermarkPct: node.highWatermarkPct,
      xpBase: node.xpBase,
      priorityLevel: node.priority,
      comboChainCount,
      attemptsCount: dailyNodeActionCounts[id] ?? 0,
    }) * yerkes;
    xpDeltas[id] = delta;
    totalXp += delta;
    if (node.progressPct >= 100 && !node.completed) unlockedIds.push(id);
  }

  const rolledUpDiffs: Record<string, number> = {};
  for (const id of changedNodeIds) {
    const node = nodes[id];
    if (!node || cycleSet.has(id) || !node.parentId) continue;
    const parent = nodes[node.parentId];
    if (!parent || cycleSet.has(node.parentId)) continue;
    const bonus = (xpDeltas[id] ?? 0) * formulaConfig.parentRollupCompletionBonusRatio;
    rolledUpDiffs[node.parentId] = (rolledUpDiffs[node.parentId] ?? 0) + bonus;
    totalXp += bonus;
  }

  const xpToNext = 200 + characterLevel * 100;
  const levelUpDelta = Math.floor(totalXp / xpToNext);

  const skillDeltas: Record<string, number> = {};
  for (const [id, xp] of Object.entries(xpDeltas)) {
    const skillIds = nodes[id]?.skillIds ?? [];
    if (skillIds.length === 0 || xp <= 0) continue;
    const share = Math.round((xp / skillIds.length) * 10) / 10;
    for (const skillId of skillIds) {
      skillDeltas[skillId] = (skillDeltas[skillId] ?? 0) + share;
    }
  }

  const shield = evaluateRecoveryShield({
    sleepDebtHours: energyBatteries.sleepDebtHours,
    activeIllnessFlag: energyBatteries.activeIllnessFlag,
    jointPainFlag: energyBatteries.jointPainFlag,
  });

  return {
    type: 'GRAPH_AND_XP_RESULT',
    requestId: request.requestId,
    snapshotRevision: request.snapshotRevision,
    rolledUpDiffs,
    xpDeltas,
    unlockedIds,
    cycleIds,
    levelUpDelta,
    skillDeltas,
    shieldSuggestion: { active: shield.active, reasons: shield.reasons, quietModeSuggested: shield.quietModeSuggested },
  };
}

self.onmessage = (event: MessageEvent<ComputeGraphAndXpRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'COMPUTE_GRAPH_AND_XP') return;
  (self as unknown as Worker).postMessage(compute(request));
};
