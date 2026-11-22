import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type { CharacterProfile, EnergyBatteries, Goal, Note, RecoveryShieldState, ScheduleBlock } from './core/types';
import { openNexusDb, getRecord, getAllRecords, putRecord } from './core/db/db';
import { ensureFirstRunSeed } from './seed/firstRun';
import { computeYerkesDodsonMultiplier } from './core/math/xp';
import { EVENT_TYPES, eventBus } from './core/eventbus/eventbus';
import { GraphWorker } from './core/worker/GraphWorker';
import type { GraphComputeNode } from './core/worker/protocol';
import type { SkillNode } from './core/types';
import { mediaBlobRepository } from './repositories/MediaBlobRepository';
import { BatteryChips, QuietBadge, XpBar } from './ui/widgets';
import { NowView } from './screens/NowView';
import { BrainView } from './screens/BrainView';
import { EnergyView } from './screens/EnergyView';
// three.js chunk is split out so the offline shell stays light
const HeroView = lazy(() => import('./screens/HeroView').then((m) => ({ default: m.HeroView })));
import WorkoutPlayer from './modules/workout/WorkoutPlayer';
import type { AudioEffect as WPAudioEffect, HapticPattern as WPHapticPattern } from './modules/workout/WorkoutPlayer';
import type { ExerciseDefinition, WorkoutProgram } from './modules/workout/WorkoutPlayer';
import { VoiceAndAudioEngine } from './modules/ux-voice/VoiceAndAudioEngine';
import type { NexusEventMap } from './modules/ux-voice/VoiceAndAudioEngine';

type ViewId = 'now' | 'brain' | 'hero' | 'energy';

const TABS: { id: ViewId; label: string }[] = [
  { id: 'now', label: 'Сейчас' },
  { id: 'brain', label: 'Мозг' },
  { id: 'hero', label: 'Герой' },
  { id: 'energy', label: 'Энергия' },
];

const DEFAULT_PROFILE: CharacterProfile = {
  id: 'primary',
  name: 'Странник',
  level: 1,
  stats: {
    Intellect: { level: 1, xp: 0, xpToNext: 100 },
    Discipline: { level: 1, xp: 0, xpToNext: 100 },
    Endurance: { level: 1, xp: 0, xpToNext: 100 },
    Wealth: { level: 1, xp: 0, xpToNext: 100 },
    Creativity: { level: 1, xp: 0, xpToNext: 100 },
  },
  experience: 0,
  nextLevelXp: 100,
};

function defaultBatteries(): EnergyBatteries {
  const avg = 70;
  return {
    Physical: avg, Emotional: avg, Mental: avg, Spiritual: avg,
    averageEnergy: avg,
    yerkesDodsonMultiplier: computeYerkesDodsonMultiplier(avg),
    sleepDebtHours: 0,
    activeIllnessFlag: false,
    jointPainFlag: false,
  };
}

// Thin structural adapters between the three engine bus contracts and core eventbus.
const voiceBus = {
  on: (event: keyof NexusEventMap & string, handler: (payload: never) => void) =>
    eventBus.on(event as Parameters<typeof eventBus.on>[0], handler as unknown as Parameters<typeof eventBus.on>[1]),
  emit: (event: keyof NexusEventMap & string, payload: unknown) =>
    eventBus.emit(event as Parameters<typeof eventBus.emit>[0], payload as never),
};

const wpAudio = {
  playEffect(effect: WPAudioEffect): void {
    const map: Record<WPAudioEffect, 'subtask_tick' | 'level_up' | 'skill_unlock' | 'workout_start' | 'shield_activate'> = {
      rest_tick: 'subtask_tick',
      rest_end: 'level_up',
      set_complete: 'subtask_tick',
      warning: 'shield_activate',
      workout_complete: 'level_up',
    };
    void voiceEngine?.playEffect(map[effect]);
  },
  vibrate(pattern: WPHapticPattern): void {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern === 'warning' ? [90, 60, 90] : 45);
  },
  get isQuietMode(): boolean {
    return voiceEngine?.quietMode ?? false;
  },
};

const wpBus = {
  emit: (event: 'workout:finished' | 'shield:activated' | 'quietMode:changed' | 'subtask:completed', payload: unknown) =>
    eventBus.emit(event as Parameters<typeof eventBus.emit>[0], payload as never),
  on: (
    event: 'workout:finished' | 'shield:activated' | 'quietMode:changed' | 'subtask:completed',
    handler: (payload: never) => void,
  ) => eventBus.on(event as Parameters<typeof eventBus.on>[0], handler as unknown as Parameters<typeof eventBus.on>[1]),
};

let voiceEngine: VoiceAndAudioEngine | null = null;
function getVoiceEngine(): VoiceAndAudioEngine | null {
  if (voiceEngine) return voiceEngine;
  try {
    voiceEngine = new VoiceAndAudioEngine(voiceBus);
  } catch (err) {
    console.error('[nexus] voice engine unavailable', err);
    voiceEngine = null;
  }
  return voiceEngine;
}

// Neural XP engine (T-A GraphWorker) — spawned lazily on first sealed order.
let graphWorker: GraphWorker | null = null;
function priorityOf(goalPriority: number | undefined): GraphComputeNode['priority'] {
  if ((goalPriority ?? 0) >= 5) return 'critical';
  if ((goalPriority ?? 0) >= 4) return 'high';
  if ((goalPriority ?? 0) >= 3) return 'medium';
  return 'low';
}

function App() {
  const [view, setView] = useState<ViewId>('now');
  const [loaded, setLoaded] = useState(false);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [schedule, setSchedule] = useState<ScheduleBlock[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [profile, setProfile] = useState<CharacterProfile>(DEFAULT_PROFILE);
  const [batteries, setBatteries] = useState<EnergyBatteries>(defaultBatteries);
  const [shield, setShield] = useState<RecoveryShieldState | undefined>(undefined);
  const [programs, setPrograms] = useState<WorkoutProgram[]>([]);
  const [exercises, setExercises] = useState<ExerciseDefinition[]>([]);
  const [pendingSync, setPendingSync] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [showWorkout, setShowWorkout] = useState(false);
  const [sealedFlash, setSealedFlash] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // fresh copy of live data for the []-effect closures (xp pipeline)
  const dataRef = useRef({ goals, batteries, profile });
  dataRef.current = { goals, batteries, profile };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureFirstRunSeed();
        const db = await openNexusDb();
        const [goalsRows, scheduleRows, noteRows, profileRow, batteryRow, shieldRow, programRows, exerciseRows] = await Promise.all([
          getAllRecords<Goal>(db, 'goals'),
          getAllRecords<ScheduleBlock>(db, 'schedule_blocks'),
          getAllRecords<Note>(db, 'notes'),
          getRecord<CharacterProfile>(db, 'character_profile', 'primary'),
          getRecord<EnergyBatteries>(db, 'energy_batteries', 'primary'),
          getRecord<RecoveryShieldState>(db, 'recovery_shield', 'primary'),
          getAllRecords<WorkoutProgram>(db, 'workout_programs'),
          getAllRecords<ExerciseDefinition>(db, 'exercise_definitions'),
        ]);
        if (!alive) return;
        setGoals(goalsRows);
        setSchedule(scheduleRows);
        setNotes(noteRows);
        if (profileRow) setProfile(profileRow);
        if (batteryRow) setBatteries(batteryRow);
        setShield(shieldRow);
        setPrograms(programRows);
        setExercises(exerciseRows);
        setPendingSync(await getAllRecords<{ status: string }>(db, 'obsidian_sync_queue').then(
          (rows) => rows.filter((r) => r.status === 'pending').length,
        ));
      } catch (err) {
        console.error('[nexus] initial load failed', err);
        setBootError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    const offSealed = eventBus.on(EVENT_TYPES.ordersSealed, async (payload) => {
      setSealedFlash(true);
      window.setTimeout(() => setSealedFlash(false), 2400);
      // Neural XP pipeline: GraphWorker computes yerkes-weighted deltas over the goal graph.
      try {
        const { goals: gs, batteries: bs, profile: pf } = dataRef.current;
        if (!graphWorker) graphWorker = new GraphWorker();
        const nodes: Record<string, GraphComputeNode> = {};
        for (const g of gs) {
          const sealed = g.id === payload.orderId;
          nodes[g.id] = {
            id: g.id,
            parentId: null,
            progressPct: sealed ? 100 : 0,
            highWatermarkPct: 0,
            // blueprint formula multiplies progressDelta(%) by xpBase; fixture xp
            // is "XP per completed goal" → normalize to per-percent scale
            xpBase: ((g as typeof g & { legacyXp?: number }).legacyXp ?? 30) / 100,
            priority: priorityOf((g as typeof g & { priority?: number }).priority),
            blockedBy: [],
            skillIds: (g as typeof g & { skills?: string[] }).skills ?? [],
            completed: false,
          };
        }
        const result = await graphWorker.compute({
          snapshotRevision: Date.now(),
          dateKey: new Date().toISOString().slice(0, 10),
          nowMs: Date.now(),
          nodes,
          changedNodeIds: [payload.orderId],
          energyBatteries: bs,
          recoveryShieldActive: false,
          comboChainCount: 0,
          dailyNodeActionCounts: {},
          characterLevel: pf.level,
          skillLevels: {},
          formulaConfig: {
            priorityMultipliers: { low: 0.85, medium: 1.0, high: 1.25, critical: 1.6 },
            comboStepPerChain: 0.08,
            comboMaxMultiplier: 1.40,
            diminishingDecayLambda: 0.35,
            diminishingFloor: 0.25,
            yerkesOptimumE: 72,
            yerkesSigma: 22,
            parentRollupCompletionBonusRatio: 0.15,
          },
        });
        const gained = Math.round(Object.values(result.xpDeltas).reduce((a, b) => a + b, 0)
          + Object.values(result.rolledUpDiffs).reduce((a, b) => a + b, 0));
        const nextLevel = pf.level + result.levelUpDelta;
        const newProfile = {
          ...pf,
          level: nextLevel,
          experience: pf.experience + gained,
          nextLevelXp: 200 + nextLevel * 100,
        };
        setProfile(newProfile);
        const db = await openNexusDb();
        await putRecord(db, 'character_profile', newProfile);
        // skill xp propagation
        for (const [skillId, delta] of Object.entries(result.skillDeltas)) {
          const node = await getRecord<SkillNode & { id: string }>(db, 'skill_nodes', skillId);
          if (node) await putRecord(db, 'skill_nodes', { ...node, xp: Math.round(((node.xp ?? 0) + delta) * 10) / 10 });
        }
        if (result.levelUpDelta > 0) {
          eventBus.emit(EVENT_TYPES.levelUp, { entityId: 'primary', oldLevel: pf.level, newLevel: nextLevel, xgained: gained });
          void getVoiceEngine()?.playEffect('level_up');
        } else {
          void getVoiceEngine()?.playEffect('subtask_tick');
        }
      } catch (err) {
        console.error('[nexus] xp pipeline failed', err);
      }
    });
    const engine = getVoiceEngine();
    setQuiet(engine?.quietMode ?? false);
    return () => {
      alive = false;
      offSealed();
      graphWorker?.dispose();
      graphWorker = null;
    };
  }, []);

  const workoutReady = programs.length > 0 && exercises.length > 0;

  const toggleQuiet = () => {
    const engine = getVoiceEngine();
    const next = !(engine?.quietMode ?? quiet);
    engine?.setQuietMode(next);
    setQuiet(next);
  };

  const activeProgram = useMemo(() => programs[0], [programs]);

  if (!loaded) {
    return (
      <div className="app-shell loading">
        <div className="loading-rune">✦ NEXUS пробуждается…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">NEXUS <span className="brand-dim">// SINGULARITY</span></div>
        <XpBar level={profile.level} xp={profile.experience} xpToNext={profile.nextLevelXp} />
        <BatteryChips batteries={batteries} />
        <div className="top-bar-right">
          {sealedFlash && <span className="sealed-flash">✦ Заказ запечатан</span>}
          <QuietBadge on={quiet} />
          <button type="button" className="icon-btn" title="Тихий режим" onClick={toggleQuiet}>{quiet ? '🔇' : '🔔'}</button>
        </div>
      </header>

      <nav className="tab-bar" aria-label="Разделы">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab ${view === t.id ? 'active' : ''}`}
            onClick={() => setView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {view === 'now' && (
          <NowView
            goals={goals}
            schedule={schedule}
            batteries={batteries}
            workoutReady={workoutReady}
            onStartWorkout={() => setShowWorkout(true)}
          />
        )}
        {view === 'now' && showWorkout && workoutReady && activeProgram && (
          <section className="workout-overlay">
            <div className="workout-overlay-head">
              <h2 className="card-title">WARRIOR-190 · {activeProgram.title}</h2>
              <button type="button" className="btn-arcane small" onClick={() => setShowWorkout(false)}>✕ Свернуть</button>
            </div>
            <WorkoutPlayer
              program={activeProgram}
              exercises={exercises}
              mediaRepo={mediaBlobRepository}
              audioEngine={wpAudio}
              eventBus={wpBus}
            />
          </section>
        )}
        {view === 'brain' && <BrainView goals={goals} notes={notes} pendingSync={pendingSync} />}
        {view === 'hero' && (
          <Suspense fallback={<div className="loading-rune">✦ Призыв святилища…</div>}>
            <HeroView profile={profile} batteries={batteries} shield={shield} quietMode={quiet} />
          </Suspense>
        )}
        {view === 'energy' && <EnergyView schedule={schedule} batteries={batteries} goals={goals} />}
      </main>

      {bootError && <div className="boot-error">⚠ Ошибка загрузки: {bootError}</div>}
      <footer className="footer">NEXUS // SINGULARITY · schema v4 · 22.11.2026</footer>
    </div>
  );
}

export default App;
