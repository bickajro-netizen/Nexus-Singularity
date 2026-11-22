// First-run seed (T-D): goals-only import from the v6 phone export + trainer
// starter data (plan v3 windows, exercises, WARRIOR-190 program, primary states).
// Desktop-first per directive 22.11; idempotent via app_meta 'first_run_done'.

import rawState from './state-phone-v6.json';
import starterExercises from '../modules/workout/starter-exercises.json';
import type { ExerciseDefinition } from '../modules/workout/WorkoutPlayer';
import { openNexusDb, putRecord, getRecord, getAllRecords } from '../core/db/db';
import type { BodyMetrics, CharacterProfile, EnergyBatteries, Goal, RecoveryShieldState, ScheduleBlock, SkillNode } from '../core/types';
import { computeYerkesDodsonMultiplier } from '../core/math/xp';

interface V6Category { id: string; name: string }
interface V6Goal {
  id: string; cat: string; title: string; type?: string; target?: number; unit?: string;
  period?: string; deadline?: string; priority?: number; xp?: number; skills?: string[];
  desc?: string; createdAt?: string;
}
interface V6Skill { id: string; name: string; icon?: string; level: number; xp: number }
interface V6State { categories: V6Category[]; goals: V6Goal[]; skills: V6Skill[] }

const AREA_COLORS: Record<string, 'Red' | 'Yellow' | 'Green'> = {
  dev: 'Yellow', phys: 'Red', study: 'Yellow', rest: 'Green',
};

const TRAINER_BLOCKS: ScheduleBlock[] = [
  { id: 'sb-selfdefense', type: 'timeblock', title: 'Self-defense (тренер)', startTime: '16:00', endTime: '17:30', daysOfWeek: [1] },
  { id: 'sb-legs', type: 'timeblock', title: 'Ноги (тренер)', startTime: '15:20', endTime: '17:00', daysOfWeek: [2] },
  { id: 'sb-upper', type: 'timeblock', title: 'Верх (тренер)', startTime: '19:00', endTime: '20:00', daysOfWeek: [5] },
  { id: 'sb-saturday', type: 'timeblock', title: 'Субботний блок', startTime: '10:00', endTime: '14:00', daysOfWeek: [6] },
  { id: 'sb-recovery', type: 'break', title: 'Восстановление', startTime: '10:00', endTime: '12:00', daysOfWeek: [0] },
];

function defaultProfile(): CharacterProfile {
  const stat = { level: 1, xp: 0, xpToNext: 100 };
  return {
    id: 'primary',
    name: 'Странник',
    level: 1,
    stats: {
      Intellect: { ...stat },
      Discipline: { ...stat },
      Endurance: { ...stat },
      Wealth: { ...stat },
      Creativity: { ...stat },
    },
    experience: 0,
    nextLevelXp: 100,
  };
}

export async function isSeeded(): Promise<boolean> {
  const db = await openNexusDb();
  const marker = await getRecord<{ id: string; version: number }>(db, 'app_meta', 'first_run_done');
  return !!marker;
}

// Repair persisted programs written by the pre-prescriptions seed: the player
// contract requires WorkoutDay{dayIndex,label,quietEveningSafe,prescriptions[]}.
// Runs on EVERY boot (cheap count check) — must cover already-marked stores.
async function repairWorkoutPrograms(db: IDBDatabase): Promise<void> {
  const all = await getAllRecords<{ id: string; exercises: string[]; days?: unknown[] }>(db, 'workout_programs');
  for (const prog of all) {
    const broken = !prog.days || prog.days.length === 0
      || (prog.days as Array<{ prescriptions?: unknown }>).some((d) => !d.prescriptions || (d.prescriptions as unknown[]).length === 0);
    if (!broken) continue;
    const exercises = prog.exercises ?? [];
    await putRecord(db, 'workout_programs', {
      ...prog,
      days: [{
        dayIndex: 0,
        label: 'Вечерний блок · комната',
        quietEveningSafe: true,
        prescriptions: exercises.map((id: string) => ({
          exerciseId: id, targetSets: 3, targetRepsMin: 8, targetRepsMax: 12, loadKg: 2, rpeCap: 8, tempo: '2-0-2',
        })),
      }],
    });
  }
}

export async function ensureFirstRunSeed(): Promise<void> {
  const db = await openNexusDb();
  await repairWorkoutPrograms(db);
  const done = await isSeeded();
  if (done) return;

  const state = rawState as unknown as V6State;
  const today = new Date().toISOString().slice(0, 10);

  // life areas from v6 categories
  for (const cat of state.categories) {
    const goalIds = state.goals.filter((g) => g.cat === cat.id).map((g) => g.id);
    await putRecord(db, 'life_areas', {
      id: cat.id, name: cat.name, color: AREA_COLORS[cat.id] ?? 'Yellow', goals: goalIds,
    });
  }

  // goals: 25 records, extra v6 fields preserved for later wave logic
  for (const g of state.goals) {
    const goal: Goal & Record<string, unknown> = {
      id: g.id,
      title: g.title,
      description: g.desc ?? '',
      lifeAreaId: g.cat,
      projects: [],
      tags: [g.unit ?? '', g.type ?? ''].filter((s) => s.length > 0),
      target: g.target,
      deadline: g.deadline,
      priority: g.priority,
      legacyXp: g.xp,
      skills: g.skills ?? [],
    };
    await putRecord(db, 'goals', goal);
  }

  // skills referenced by goals only (11 unique ids expected)
  const referenced = new Set<string>();
  for (const g of state.goals) for (const s of g.skills ?? []) referenced.add(s);
  for (const s of state.skills) {
    if (!referenced.has(s.id)) continue;
    const node: SkillNode = {
      id: s.id,
      title: s.name,
      description: `${s.icon ?? '✦'} ${s.name}`,
      subTechniques: [],
      unlocked: s.level > 0,
      xp: s.xp ?? 0,
    };
    await putRecord(db, 'skill_nodes', node);
  }

  // trainer plan v3 windows (Ср/Чт — выходной)
  for (const block of TRAINER_BLOCKS) {
    await putRecord(db, 'schedule_blocks', block);
  }

  // exercise definitions + WARRIOR-190 program
  const exercises = starterExercises as ExerciseDefinition[];
  for (const ex of exercises) {
    await putRecord(db, 'exercise_definitions', ex);
  }
  await putRecord(db, 'workout_programs', {
    id: 'wp-warrior-190',
    title: 'WARRIOR-190 · Дом',
    description: 'Тренер-план v3: RPE≤8, без 1ПМ, без мостов головой/шеей.',
    exercises: exercises.map((e) => e.id),
    created: new Date().toISOString(),
    rpeCap: 8,
    allow1RM: false,
    forbidHeadNeckBridges: true,
    days: [{
      // WorkoutDay contract (WorkoutPlayer): dayIndex/label/quietEveningSafe/prescriptions
      dayIndex: 0,
      label: 'Вечерний блок · комната',
      quietEveningSafe: true,
      prescriptions: exercises.map((e) => ({
        exerciseId: e.id,
        targetSets: 3,
        targetRepsMin: 8,
        targetRepsMax: 12,
        loadKg: 2,
        rpeCap: 8,
        tempo: '2-0-2',
      })),
    }],
  });

  // primary states
  const metrics: BodyMetrics = {
    id: today, date: today, weight: 87, sleepHours: 7, sleepQuality: 3, soreness: 2,
    tonsilPainFlag: false, jointPainAreas: [], girths: {},
  };
  await putRecord(db, 'body_metrics', metrics);

  const batteries: EnergyBatteries & { id: string } = {
    id: 'primary',
    Physical: 70, Emotional: 70, Mental: 70, Spiritual: 70,
    averageEnergy: 70,
    yerkesDodsonMultiplier: computeYerkesDodsonMultiplier(70),
    sleepDebtHours: 0,
    activeIllnessFlag: false,
    jointPainFlag: false,
  };
  await putRecord(db, 'energy_batteries', batteries);

  const shield: RecoveryShieldState & { id: string } = {
    id: 'primary',
    active: false, reasons: [], freezeStreak: false, convertedQuestIds: [], quietModeSuggested: false,
  };
  await putRecord(db, 'recovery_shield', shield);

  await putRecord(db, 'character_profile', defaultProfile());

  await putRecord(db, 'app_meta', { id: 'first_run_done', version: 1, at: new Date().toISOString() });
}
