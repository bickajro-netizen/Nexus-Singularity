import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type { CharacterProfile, EnergyBatteries, Goal, Note, RecoveryShieldState, ScheduleBlock } from './core/types';
import { openNexusDb, getRecord, getAllRecords, putRecord, deleteRecord } from './core/db/db';
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
import type { ExerciseDefinition, WorkoutLog, WorkoutProgram } from './modules/workout/WorkoutPlayer';
import { VoiceAndAudioEngine } from './modules/ux-voice/VoiceAndAudioEngine';
import { NexusBridge } from './modules/ux-voice/NexusBridge';
import { syncQueueRepository } from './repositories/SyncQueueRepository';
import { noteRepository } from './repositories/NoteRepository';
import { CommandPalette } from './ui/CommandPalette';
import type { PaletteAction } from './ui/CommandPalette';
import { NoteComposer } from './ui/NoteComposer';
import type { ComposerNote } from './ui/NoteComposer';
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
// Obsidian sync bridge — one instance per app session (AES key lives in IDB).
let nexusBridge: NexusBridge | null = null;
function getNexusBridge(): NexusBridge {
  if (!nexusBridge) nexusBridge = new NexusBridge();
  return nexusBridge;
}
// XP idempotency: one award per workout log
const processedWorkoutLogs = new Set<string>();
// Shared GraphWorker formula config (goals pipeline + workout pipeline)
const FORMULA_CONFIG = {
  priorityMultipliers: { low: 0.85, medium: 1.0, high: 1.25, critical: 1.6 },
  comboStepPerChain: 0.08,
  comboMaxMultiplier: 1.40,
  diminishingDecayLambda: 0.35,
  diminishingFloor: 0.25,
  yerkesOptimumE: 72,
  yerkesSigma: 22,
  parentRollupCompletionBonusRatio: 0.15,
};
function priorityOf(goalPriority: number | undefined): GraphComputeNode['priority'] {
  if ((goalPriority ?? 0) >= 5) return 'critical';
  if ((goalPriority ?? 0) >= 4) return 'high';
  if ((goalPriority ?? 0) >= 3) return 'medium';
  return 'low';
}

function sumGained(result: { xpDeltas: Record<string, number>; rolledUpDiffs: Record<string, number> }): number {
  const raw = Object.values(result.xpDeltas).reduce((a, b) => a + b, 0)
    + Object.values(result.rolledUpDiffs).reduce((a, b) => a + b, 0);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
}

// answer 3а: XP accumulates raw; normalize so the bar shows progress WITHIN
// the level (level catches up immediately, not on the next event)
function normalizeProfileLevel(p: CharacterProfile): CharacterProfile {
  let level = Math.max(1, Math.floor(p.level ?? 1));
  let exp = Math.max(0, Math.floor(p.experience ?? 0));
  let next = p.nextLevelXp && p.nextLevelXp > 0 ? p.nextLevelXp : 200 + level * 100;
  let guard = 0;
  while (exp >= next && guard++ < 100) {
    exp -= next;
    level += 1;
    next = 200 + level * 100;
  }
  return { ...p, level, experience: exp, nextLevelXp: next };
}

// Serialize profile read-modify-write: ordersSealed and workout:finished can
// overlap, and last-write-wins would silently drop XP.
let profileChain: Promise<void> = Promise.resolve();
function enqueueProfileWrite(task: () => Promise<void>): Promise<void> {
  const next = profileChain.then(task, task);
  profileChain = next.catch(() => undefined);
  return next;
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  // fresh copy of live data for the []-effect closures (xp pipeline)
  const dataRef = useRef({ goals, batteries, profile });
  dataRef.current = { goals, batteries, profile };
  const [obsidianStatus, setObsidianStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [obsidianToken, setObsidianToken] = useState('');
  const [obsidianBusy, setObsidianBusy] = useState(false);

  const refreshPendingSync = useCallback(async () => {
    try {
      // mirror the bridge's flush filter: pending + retrying both need sending
      const rows = await syncQueueRepository.listAll();
      setPendingSync(rows.filter((r) => r.status === 'pending' || r.status === 'retrying').length);
    } catch {
      // queue store unavailable — keep the last count
    }
  }, []);

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
        if (profileRow) {
          const norm = normalizeProfileLevel(profileRow);
          if (JSON.stringify(norm) !== JSON.stringify(profileRow)) {
            await putRecord(db, 'character_profile', norm);
          }
          setProfile(norm);
        }
        if (batteryRow) setBatteries(batteryRow);
        setShield(shieldRow);
        setPrograms(programRows);
        setExercises(exerciseRows);
        await refreshPendingSync();
      } catch (err) {
        console.error('[nexus] initial load failed', err);
        setBootError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    // Obsidian bridge: init + flush only when a token was saved earlier — boot
    // must never depend on Obsidian running, and flushQueue() without a token
    // would poison the reauth flag.
    void (async () => {
      try {
        const bridge = getNexusBridge();
        await bridge.init();
        if (await bridge.getDecryptedToken()) {
          await bridge.flushQueue();
          setObsidianStatus((await bridge.checkConnection()) ? 'ok' : 'fail');
        }
      } catch (err) {
        console.error('[nexus] obsidian bridge init failed', err);
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
          formulaConfig: FORMULA_CONFIG,
        });
        const gained = sumGained(result);
        await enqueueProfileWrite(async () => {
          const { profile: current } = dataRef.current;
          const nextLevel = current.level + result.levelUpDelta;
          const newProfile = normalizeProfileLevel({
            ...current,
            level: nextLevel,
            experience: current.experience + gained,
            nextLevelXp: 200 + nextLevel * 100,
          });
          setProfile(newProfile);
          const db = await openNexusDb();
          await putRecord(db, 'character_profile', newProfile);
          // skill xp propagation
          for (const [skillId, delta] of Object.entries(result.skillDeltas)) {
            const node = await getRecord<SkillNode & { id: string }>(db, 'skill_nodes', skillId);
            if (node) await putRecord(db, 'skill_nodes', { ...node, xp: Math.round(((node.xp ?? 0) + delta) * 10) / 10 });
          }
          if (newProfile.level > current.level) {
            eventBus.emit(EVENT_TYPES.levelUp, { entityId: 'primary', oldLevel: current.level, newLevel: newProfile.level, xgained: gained });
            void getVoiceEngine()?.playEffect('level_up');
          } else {
            void getVoiceEngine()?.playEffect('subtask_tick');
          }
        });
      } catch (err) {
        console.error('[nexus] xp pipeline failed', err);
      }
    });
    // Workout XP: persist the WARRIOR-190 log, then award XP through the same
    // GraphWorker pipeline (one node per program, ratio-based progress).
    const offWorkout = wpBus.on('workout:finished', async (log: WorkoutLog) => {
      try {
        if (processedWorkoutLogs.has(log.id)) return;
        processedWorkoutLogs.add(log.id);
        const db = await openNexusDb();
        // IDB is the source of truth for idempotency (the in-memory guard dies on reload)
        const existing = await getRecord<WorkoutLog>(db, 'workout_logs', log.id);
        if (existing) return;
        const { batteries: bs, profile: pf } = dataRef.current;
        if (!graphWorker) graphWorker = new GraphWorker();
        const totalSets = log.sets.length;
        const completedCount = log.sets.filter((s) => s.completed).length;
        const nodes: Record<string, GraphComputeNode> = {
          [log.programId]: {
            id: log.programId,
            parentId: null,
            progressPct: totalSets > 0 ? Math.round((100 * completedCount) / totalSets) : 0,
            highWatermarkPct: 0,
            xpBase: 2.5,
            priority: 'medium',
            blockedBy: [],
            skillIds: [],
            completed: false,
          },
        };
        const result = await graphWorker.compute({
          snapshotRevision: Date.now(),
          dateKey: new Date().toISOString().slice(0, 10),
          nowMs: Date.now(),
          nodes,
          changedNodeIds: [log.programId],
          energyBatteries: bs,
          recoveryShieldActive: false,
          comboChainCount: 0,
          dailyNodeActionCounts: {},
          characterLevel: pf.level,
          skillLevels: {},
          formulaConfig: FORMULA_CONFIG,
        });
        // persist the log only after a successful compute, so a pipeline failure
        // leaves the IDB idempotency guard clean for a re-emitted log
        await putRecord(db, 'workout_logs', log);
        const gained = sumGained(result);
        await enqueueProfileWrite(async () => {
          const { profile: current } = dataRef.current;
          const nextLevel = current.level + result.levelUpDelta;
          const newProfile = normalizeProfileLevel({
            ...current,
            level: nextLevel,
            experience: current.experience + gained,
            nextLevelXp: 200 + nextLevel * 100,
          });
          setProfile(newProfile);
          await putRecord(await openNexusDb(), 'character_profile', newProfile);
          if (newProfile.level > current.level) {
            eventBus.emit(EVENT_TYPES.levelUp, { entityId: 'primary', oldLevel: current.level, newLevel: newProfile.level, xgained: gained });
            void getVoiceEngine()?.playEffect('level_up');
          } else {
            void getVoiceEngine()?.playEffect('subtask_tick');
          }
        });
      } catch (err) {
        // rollback: let a re-emitted log retry the whole pipeline
        processedWorkoutLogs.delete(log.id);
        try {
          await deleteRecord(await openNexusDb(), 'workout_logs', log.id);
        } catch { /* log row never landed */ }
        console.error('[nexus] workout xp pipeline failed', err);
      }
    });
    const offSyncQueued = eventBus.on(EVENT_TYPES.syncQueued, () => void refreshPendingSync());
    // bridge flushes on its own heartbeat — keep the badge honest between flushes
    const syncTimer = window.setInterval(() => void refreshPendingSync(), 30000);
    // Ctrl+K / Cmd+K command palette
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    const engine = getVoiceEngine();
    setQuiet(engine?.quietMode ?? false);
    return () => {
      alive = false;
      offSealed();
      offWorkout();
      offSyncQueued();
      window.removeEventListener('keydown', onKey);
      window.clearInterval(syncTimer);
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

  const connectObsidian = async () => {
    const token = obsidianToken.trim();
    if (!token || obsidianBusy) return;
    setObsidianBusy(true);
    try {
      const bridge = getNexusBridge();
      await bridge.setObsidianToken(token);
      await bridge.flushQueue();
      setObsidianStatus((await bridge.checkConnection()) ? 'ok' : 'fail');
      await refreshPendingSync();
    } catch {
      setObsidianStatus('fail');
    } finally {
      setObsidianBusy(false);
      setObsidianToken('');
    }
  };

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = TABS.map((t) => ({
      id: `view-${t.id}`,
      label: `Раздел: ${t.label}`,
      hint: 'перейти',
      run: () => setView(t.id),
    }));
    if (workoutReady) {
      acts.push({
        id: 'workout-start',
        label: '⚔ Начать тренировку (WARRIOR-190)',
        hint: 'Сейчас',
        run: () => { setView('now'); setShowWorkout(true); },
      });
    }
    acts.push({
      id: 'quiet-toggle',
      label: quiet ? '🔊 Выключить тихий режим' : '🔇 Включить тихий режим',
      hint: 'звук',
      run: () => toggleQuiet(),
    });
    return acts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workoutReady, quiet]);

  // Гримуар: сохранить в notes store и сразу вытолкнуть в vault Obsidian
  const saveNote = async (n: ComposerNote) => {
    const now = new Date().toISOString();
    const noteId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `note_${Date.now().toString(36)}`;
    const created: Note = {
      id: noteId,
      title: n.title,
      content: n.bodyMd,
      created: now,
      modified: now,
      backlinks: [],
    };
    await noteRepository.create(created);
    setNotes((prev) => [...prev, created]);
    const safeTitle = n.title.replace(/[\\/:*?"<>|]/g, '-').trim();
    const path = n.noteType === 'daily_journal' && n.dateKey
      ? `NEXUS/Daily/${n.dateKey} ${safeTitle}.md`
      : `NEXUS/Notes/${safeTitle}.md`;
    void getNexusBridge().pushMarkdown(path, n.bodyMd).then(() => refreshPendingSync());
  };

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
        {view === 'brain' && (
          <section className="grimoire-composer">
            <h2 className="card-title">❖ Гримуар · новая запись</h2>
            <NoteComposer onSave={saveNote} />
          </section>
        )}
        {view === 'brain' && (
          <section className="obsidian-panel">
            <span className={`sync-badge ${obsidianStatus === 'ok' ? 'ok' : obsidianStatus === 'fail' ? 'warn' : ''}`}>
              {obsidianStatus === 'ok'
                ? 'Obsidian подключён'
                : obsidianStatus === 'fail'
                  ? 'Obsidian не отвечает'
                  : 'Obsidian не подключён'}
            </span>
            <input
              type="password"
              className="obsidian-input"
              placeholder="API-ключ Obsidian (Local REST API)"
              value={obsidianToken}
              onChange={(e) => setObsidianToken(e.target.value)}
            />
            <button type="button" className="btn-arcane small" onClick={() => void connectObsidian()} disabled={obsidianBusy || obsidianToken.trim() === ''}>
              {obsidianBusy ? '…' : 'Синхронизировать'}
            </button>
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

      <nav className="bottom-nav" aria-label="Разделы">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={view === t.id ? 'active' : ''}
            onClick={() => setView(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="fab"
          title="Тренировка WARRIOR-190"
          onClick={() => { setView('now'); setShowWorkout(true); }}
          disabled={!workoutReady}
        >
          ⚔
        </button>
      </nav>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} actions={paletteActions} />
    </div>
  );
}

export default App;
