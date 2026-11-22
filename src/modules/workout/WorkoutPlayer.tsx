import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IndexedDBMediaBlobRepository, type MediaBlobRepository } from '../../repositories/MediaBlobRepository';
import type { MediaBlobRecord } from '../../repositories/contracts';
import './WorkoutPlayer.css';

export type DormEquipment = 'bodyweight' | 'dumbbell_2kg_pair' | 'yoga_mat' | 'loadable_backpack';

export interface ExerciseDefinition {
  id: string;
  name: string;
  type: 'strength' | 'cardio' | 'mobility';
  muscleGroups: string[];
  equipmentRequired: DormEquipment[];
  isSilentLowImpact: boolean;
  isHeadNeckBridge: boolean;
  defaultRpeCap: 8;
  formCues: string[];
  safetyWarning: string;
  swapAlternativeId?: string | null;
  mediaBlobId?: string;
  localVideoPath?: string;
  fallbackYoutubeUrl?: string;
}

export interface WorkoutProgram {
  id: string;
  title: string;
  description: string;
  exercises: string[];
  created: string;
  rpeCap: 8;
  allow1RM: false;
  forbidHeadNeckBridges: true;
  days: WorkoutDay[];
}

export interface WorkoutDay {
  dayIndex: number;
  label: string;
  quietEveningSafe: boolean;
  prescriptions: Array<{
    exerciseId: string;
    targetSets: number;
    targetRepsMin: number;
    targetRepsMax: number;
    loadKg: number;
    rpeCap: number;
    tempo?: string;
  }>;
}

export interface WorkoutLog {
  id: string;
  programId: string;
  date: string;
  sets: WorkoutSet[];
  maxRpeReported: number;
  illnessStopFlag: boolean;
  jointPainStopFlag: boolean;
  abortedForSafety: boolean;
}

export interface WorkoutSet {
  exerciseId: string;
  setIndex: number;
  repsCompleted: number;
  loadKg: number;
  rpe: number;
  completed: boolean;
}

export type AudioEffect = 'rest_tick' | 'rest_end' | 'set_complete' | 'warning' | 'workout_complete';
export type HapticPattern = 'rest_end' | 'warning' | 'set_complete' | 'timer_tick';

export interface AudioEngine {
  playEffect(effect: AudioEffect): void;
  vibrate(pattern: HapticPattern): void;
  isQuietMode: boolean;
}

type WorkoutEventMap = {
  'workout:finished': WorkoutLog;
  'shield:activated': { reason: 'illness' | 'joint_pain'; workoutLog: WorkoutLog; at: string };
  'quietMode:changed': { isQuietMode: boolean };
  'subtask:completed': { subtask: string; at: string };
};

export interface EventBus {
  emit<K extends keyof WorkoutEventMap>(event: K, payload: WorkoutEventMap[K]): void;
  on<K extends keyof WorkoutEventMap>(event: K, handler: (payload: WorkoutEventMap[K]) => void): () => void;
}

export interface WorkoutPlayerProps {
  program: WorkoutProgram;
  exercises: ExerciseDefinition[];
  dayIndex?: number;
  mediaRepo: MediaBlobRepository;
  audioEngine: AudioEngine;
  eventBus: EventBus;
  initialLoadUnit?: 'kg' | 'backpack_books';
}

type MediaSource =
  | { kind: 'blob'; url: string; blobId: string }
  | { kind: 'local'; url: string }
  | { kind: 'youtube'; url: string }
  | { kind: 'placeholder' };

interface ActiveSetState {
  repsCompleted: number;
  loadKg: number;
  rpe: number;
  loadUnit: 'kg' | 'backpack_books';
}

const BOOK_KG = 0.45;

function uid(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function toKg(value: number, unit: 'kg' | 'backpack_books'): number {
  return unit === 'backpack_books' ? Number((value * BOOK_KG).toFixed(2)) : Number(value.toFixed(2));
}

function fromKg(kg: number, unit: 'kg' | 'backpack_books'): number {
  return unit === 'backpack_books' ? Math.round(kg / BOOK_KG) : Number(kg.toFixed(2));
}

function youtubeEmbedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1);
    else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') ?? '';
      else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] ?? '';
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] ?? '';
    }
    if (!id) return null;
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=0&mute=1&playsinline=1&loop=1&playlist=${id}&rel=0`;
  } catch {
    return null;
  }
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function calcXp(log: WorkoutLog): number {
  const completed = log.sets.filter((s) => s.completed).length;
  const volume = log.sets.reduce((acc, s) => acc + (s.completed ? s.repsCompleted * Math.max(0.5, s.loadKg) : 0), 0);
  const safetyPenalty = log.abortedForSafety ? 0.6 : 1;
  return Math.max(0, Math.round((completed * 12 + volume * 0.8) * safetyPenalty));
}

const BiomechPlaceholder: React.FC<{ exercise: ExerciseDefinition }> = ({ exercise }) => {
  const cue = exercise.formCues[0] ?? 'Controlled motion';
  return (
    <div className="wp-placeholder" role="img" aria-label={`Animated placeholder for ${exercise.name}`}>
      <svg className="wp-placeholder-svg" viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="wp-gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8a5a1f" />
            <stop offset="50%" stopColor="#f0d48a" />
            <stop offset="100%" stopColor="#8a5a1f" />
          </linearGradient>
          <filter id="wp-glow">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect x="0" y="0" width="320" height="180" fill="#120d18" />
        <g stroke="rgba(240,212,138,0.12)" strokeWidth="1">
          {Array.from({ length: 9 }).map((_, i) => (
            <line key={`v${i}`} x1={i * 40} y1="0" x2={i * 40} y2="180" />
          ))}
          {Array.from({ length: 5 }).map((_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 45} x2="320" y2={i * 45} />
          ))}
        </g>
        <circle cx="160" cy="45" r="12" fill="none" stroke="url(#wp-gold)" strokeWidth="2.5" filter="url(#wp-glow)" />
        <line x1="160" y1="57" x2="160" y2="105" stroke="url(#wp-gold)" strokeWidth="3" strokeLinecap="round">
          <animate attributeName="y2" values="105;101;105" dur="2.4s" repeatCount="indefinite" />
        </line>
        <line x1="160" y1="70" x2="130" y2="92" stroke="url(#wp-gold)" strokeWidth="2.5" strokeLinecap="round">
          <animate attributeName="y2" values="92;84;92" dur="2.4s" repeatCount="indefinite" />
        </line>
        <line x1="160" y1="70" x2="190" y2="92" stroke="url(#wp-gold)" strokeWidth="2.5" strokeLinecap="round">
          <animate attributeName="y2" values="92;84;92" dur="2.4s" repeatCount="indefinite" />
        </line>
        <line x1="160" y1="105" x2="142" y2="138" stroke="url(#wp-gold)" strokeWidth="2.5" strokeLinecap="round">
          <animate attributeName="y1" values="105;101;105" dur="2.4s" repeatCount="indefinite" />
        </line>
        <line x1="160" y1="105" x2="178" y2="138" stroke="url(#wp-gold)" strokeWidth="2.5" strokeLinecap="round">
          <animate attributeName="y1" values="105;101;105" dur="2.4s" repeatCount="indefinite" />
        </line>
        <ellipse cx="160" cy="145" rx="42" ry="6" fill="rgba(240,212,138,0.08)">
          <animate attributeName="rx" values="42;38;42" dur="2.4s" repeatCount="indefinite" />
        </ellipse>
      </svg>
      <div className="wp-placeholder-meta">
        <span className="wp-placeholder-title">{exercise.name}</span>
        <span className="wp-placeholder-cue">{cue}</span>
      </div>
    </div>
  );
};

export const WorkoutPlayer: React.FC<WorkoutPlayerProps> = ({
  program,
  exercises,
  dayIndex,
  mediaRepo,
  audioEngine,
  eventBus,
  initialLoadUnit = 'kg',
}) => {
  const exerciseMap = useMemo(() => {
    const m = new Map<string, ExerciseDefinition>();
    for (const ex of exercises) m.set(ex.id, ex);
    return m;
  }, [exercises]);

  const resolvedDay = useMemo<WorkoutDay>(() => {
    if (program.days.length === 0) {
      return {
        dayIndex: 0,
        label: 'Session',
        quietEveningSafe: true,
        prescriptions: program.exercises.map((id) => ({
          exerciseId: id,
          targetSets: 3,
          targetRepsMin: 8,
          targetRepsMax: 12,
          loadKg: 0,
          rpeCap: 8,
        })),
      };
    }
    const pickDay = (d: WorkoutDay | undefined): WorkoutDay => {
      // legacy programs (pre-prescriptions seed) have no day shape — synthesize
      const day = d ?? { dayIndex: 0, label: 'Session', quietEveningSafe: true, prescriptions: [] };
      if (day.prescriptions && day.prescriptions.length > 0) return day;
      return {
        ...day,
        prescriptions: program.exercises.map((id) => ({
          exerciseId: id,
          targetSets: 3,
          targetRepsMin: 8,
          targetRepsMax: 12,
          loadKg: 0,
          rpeCap: 8,
        })),
      };
    };
    if (typeof dayIndex === 'number') {
      return pickDay(program.days.find((d) => d.dayIndex === dayIndex) ?? program.days[0]);
    }
    return pickDay(program.days[0]);
  }, [program, dayIndex]);

  const [exerciseOrder, setExerciseOrder] = useState<string[]>(() =>
    resolvedDay.prescriptions.map((p) => p.exerciseId),
  );
  const [activeExerciseIdx, setActiveExerciseIdx] = useState(0);
  const [activeSetIdx, setActiveSetIdx] = useState(0);
  const [completedSets, setCompletedSets] = useState<WorkoutSet[]>([]);
  const [setState, setSetState] = useState<ActiveSetState>(() => {
    const p = resolvedDay.prescriptions[0];
    return {
      repsCompleted: p?.targetRepsMin ?? 8,
      loadKg: p?.loadKg ?? 0,
      rpe: Math.min(7, p?.rpeCap ?? 8),
      loadUnit: initialLoadUnit,
    };
  });
  const [mediaSource, setMediaSource] = useState<MediaSource>({ kind: 'placeholder' });
  const [mediaLoading, setMediaLoading] = useState(false);
  const [videoPaused, setVideoPaused] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [restSeconds, setRestSeconds] = useState(90);
  const [restRemaining, setRestRemaining] = useState<number | null>(null);
  const [restRunning, setRestRunning] = useState(false);
  const [finishedLog, setFinishedLog] = useState<WorkoutLog | null>(null);
  const [xpSummary, setXpSummary] = useState<number | null>(null);
  const [safetyFlags, setSafetyFlags] = useState({ illness: false, jointPain: false });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoShellRef = useRef<HTMLDivElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const restTimerRef = useRef<number | null>(null);
  const attachInputRef = useRef<HTMLInputElement | null>(null);

  const currentExerciseId = exerciseOrder[activeExerciseIdx] ?? resolvedDay.prescriptions[0]?.exerciseId;
  const currentExercise = currentExerciseId ? exerciseMap.get(currentExerciseId) ?? null : null;
  const currentPrescription = useMemo(() => {
    return (
      resolvedDay.prescriptions.find((p) => p.exerciseId === currentExerciseId) ??
      resolvedDay.prescriptions[activeExerciseIdx] ??
      resolvedDay.prescriptions[0]
    );
  }, [resolvedDay.prescriptions, currentExerciseId, activeExerciseIdx]);

  const totalSets = currentPrescription?.targetSets ?? 1;
  const overreach = setState.rpe > 8;
  const isQuiet = audioEngine.isQuietMode;

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  useEffect(() => revokeBlobUrl, [revokeBlobUrl]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(document.fullscreenElement === videoShellRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolveMedia = async () => {
      if (!currentExercise) {
        setMediaSource({ kind: 'placeholder' });
        return;
      }
      setMediaLoading(true);
      try {
        if (currentExercise.mediaBlobId) {
          const rec = await mediaRepo.get(currentExercise.mediaBlobId);
          if (!cancelled && rec?.blob) {
            revokeBlobUrl();
            const url = URL.createObjectURL(rec.blob);
            blobUrlRef.current = url;
            setMediaSource({ kind: 'blob', url, blobId: rec.id });
            return;
          }
        }
        const owned = await mediaRepo.getByOwner('exercise', currentExercise.id);
        if (!cancelled && owned.length > 0) {
          const latest = owned.sort((a, b) => b.createdAt - a.createdAt)[0];
          revokeBlobUrl();
          const url = URL.createObjectURL(latest.blob);
          blobUrlRef.current = url;
          setMediaSource({ kind: 'blob', url, blobId: latest.id });
          return;
        }
        if (!cancelled && currentExercise.localVideoPath) {
          revokeBlobUrl();
          setMediaSource({ kind: 'local', url: currentExercise.localVideoPath });
          return;
        }
        if (!cancelled && currentExercise.fallbackYoutubeUrl && navigator.onLine) {
          const embed = youtubeEmbedUrl(currentExercise.fallbackYoutubeUrl);
          if (embed) {
            revokeBlobUrl();
            setMediaSource({ kind: 'youtube', url: embed });
            return;
          }
        }
        if (!cancelled) {
          revokeBlobUrl();
          setMediaSource({ kind: 'placeholder' });
        }
      } catch {
        if (!cancelled) {
          revokeBlobUrl();
          setMediaSource({ kind: 'placeholder' });
        }
      } finally {
        if (!cancelled) setMediaLoading(false);
      }
    };
    void resolveMedia();
    return () => {
      cancelled = true;
    };
  }, [currentExercise, mediaRepo, revokeBlobUrl]);

  useEffect(() => {
    setVideoPaused(false);
  }, [mediaSource.kind, currentExerciseId]);

  useEffect(() => {
    if (!restRunning || restRemaining === null) return;
    if (restRemaining <= 0) {
      setRestRunning(false);
      setRestRemaining(null);
      if (isQuiet) {
        audioEngine.vibrate('rest_end');
      } else {
        audioEngine.playEffect('rest_end');
        audioEngine.vibrate('rest_end');
      }
      return;
    }
    restTimerRef.current = window.setTimeout(() => {
      setRestRemaining((prev) => (prev === null ? null : prev - 1));
    }, 1000);
    return () => {
      if (restTimerRef.current !== null) {
        window.clearTimeout(restTimerRef.current);
        restTimerRef.current = null;
      }
    };
  }, [restRunning, restRemaining, isQuiet, audioEngine]);

  const stopRest = useCallback(() => {
    setRestRunning(false);
    setRestRemaining(null);
    if (restTimerRef.current !== null) {
      window.clearTimeout(restTimerRef.current);
      restTimerRef.current = null;
    }
  }, []);

  const startRest = useCallback(() => {
    setRestRemaining(restSeconds);
    setRestRunning(true);
  }, [restSeconds]);

  const adjustRest = useCallback((delta: number) => {
    setRestSeconds((prev) => clamp(prev + delta, 15, 300));
    setRestRemaining((prev) => (prev === null ? null : clamp(prev + delta, 0, 300)));
  }, []);

  const buildLog = useCallback(
    (sets: WorkoutSet[], flags: { illness: boolean; jointPain: boolean }, abortedForSafety: boolean): WorkoutLog => {
      const maxRpeReported = sets.reduce((m, s) => Math.max(m, s.rpe), 0);
      return {
        id: uid('wlog'),
        programId: program.id,
        date: new Date().toISOString(),
        sets,
        maxRpeReported,
        illnessStopFlag: flags.illness,
        jointPainStopFlag: flags.jointPain,
        abortedForSafety,
      };
    },
    [program.id],
  );

  const finishWorkout = useCallback(
    (sets: WorkoutSet[], flags: { illness: boolean; jointPain: boolean }, abortedForSafety: boolean) => {
      stopRest();
      const log = buildLog(sets, flags, abortedForSafety);
      setFinishedLog(log);
      const xp = calcXp(log);
      setXpSummary(xp);
      eventBus.emit('workout:finished', log);
      if (!isQuiet) audioEngine.playEffect('workout_complete');
      else audioEngine.vibrate('set_complete');
    },
    [audioEngine, buildLog, eventBus, isQuiet, stopRest],
  );

  const abortForSafety = useCallback(
    (reason: 'illness' | 'joint_pain') => {
      const flags = {
        illness: reason === 'illness' ? true : safetyFlags.illness,
        jointPain: reason === 'joint_pain' ? true : safetyFlags.jointPain,
      };
      setSafetyFlags(flags);
      const log = buildLog(completedSets, flags, true);
      setFinishedLog(log);
      setXpSummary(calcXp(log));
      eventBus.emit('shield:activated', { reason, workoutLog: log, at: new Date().toISOString() });
      eventBus.emit('workout:finished', log);
      if (isQuiet) audioEngine.vibrate('warning');
      else {
        audioEngine.playEffect('warning');
        audioEngine.vibrate('warning');
      }
      stopRest();
    },
    [audioEngine, buildLog, completedSets, eventBus, isQuiet, safetyFlags.illness, safetyFlags.jointPain, stopRest],
  );

  const advanceAfterSet = useCallback(
    (nextSets: WorkoutSet[]) => {
      const nextSetIdx = activeSetIdx + 1;
      if (nextSetIdx < totalSets) {
        setActiveSetIdx(nextSetIdx);
        startRest();
        return;
      }
      const nextExerciseIdx = activeExerciseIdx + 1;
      if (nextExerciseIdx < exerciseOrder.length) {
        setActiveExerciseIdx(nextExerciseIdx);
        setActiveSetIdx(0);
        const nextExId = exerciseOrder[nextExerciseIdx];
        const nextPrescription = resolvedDay.prescriptions.find((p) => p.exerciseId === nextExId) ?? resolvedDay.prescriptions[nextExerciseIdx];
        setSetState((prev) => ({
          repsCompleted: nextPrescription?.targetRepsMin ?? prev.repsCompleted,
          loadKg: nextPrescription?.loadKg ?? prev.loadKg,
          rpe: Math.min(7, nextPrescription?.rpeCap ?? 8),
          loadUnit: prev.loadUnit,
        }));
        startRest();
        return;
      }
      finishWorkout(nextSets, safetyFlags, false);
    },
    [activeExerciseIdx, activeSetIdx, exerciseOrder, finishWorkout, resolvedDay.prescriptions, safetyFlags, startRest, totalSets],
  );

  const commitSet = useCallback(() => {
    if (!currentExercise || !currentPrescription || finishedLog) return;
    const entry: WorkoutSet = {
      exerciseId: currentExercise.id,
      setIndex: activeSetIdx,
      repsCompleted: clamp(Math.round(setState.repsCompleted), 0, 200),
      loadKg: toKg(setState.loadKg, setState.loadUnit),
      rpe: clamp(Math.round(setState.rpe), 1, 10),
      completed: true,
    };
    const nextSets = [...completedSets, entry];
    setCompletedSets(nextSets);
    eventBus.emit('subtask:completed', { subtask: `set:${currentExercise.id}:${activeSetIdx + 1}`, at: new Date().toISOString() });
    if (isQuiet) audioEngine.vibrate('set_complete');
    else {
      audioEngine.playEffect('set_complete');
      audioEngine.vibrate('set_complete');
    }
    setSetState((prev) => ({
      ...prev,
      repsCompleted: clamp(prev.repsCompleted, currentPrescription.targetRepsMin, currentPrescription.targetRepsMax),
      rpe: clamp(prev.rpe, 1, 10),
    }));
    advanceAfterSet(nextSets);
  }, [activeSetIdx, advanceAfterSet, audioEngine, completedSets, currentExercise, currentPrescription, eventBus, finishedLog, isQuiet, setState]);

  const swapExercise = useCallback(() => {
    if (!currentExercise?.swapAlternativeId || finishedLog) return;
    const altId = currentExercise.swapAlternativeId;
    if (!exerciseMap.has(altId)) return;
    setExerciseOrder((prev) => prev.map((id, idx) => (idx === activeExerciseIdx ? altId : id)));
    setActiveSetIdx(0);
    const altPrescription = resolvedDay.prescriptions.find((p) => p.exerciseId === altId);
    setSetState((prev) => ({
      ...prev,
      repsCompleted: altPrescription?.targetRepsMin ?? prev.repsCompleted,
      loadKg: altPrescription?.loadKg ?? 0,
      rpe: Math.min(prev.rpe, altPrescription?.rpeCap ?? 8),
    }));
    stopRest();
    eventBus.emit('subtask:completed', { subtask: `swap:${currentExercise.id}->${altId}`, at: new Date().toISOString() });
  }, [activeExerciseIdx, currentExercise, eventBus, exerciseMap, finishedLog, resolvedDay.prescriptions, stopRest]);

  const toggleVideoPlayback = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play().catch(() => undefined);
      setVideoPaused(false);
    } else {
      v.pause();
      setVideoPaused(true);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const shell = videoShellRef.current;
    if (!shell) return;
    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else if (shell.requestFullscreen) {
        await shell.requestFullscreen();
      }
    } catch {
      setIsFullscreen((prev) => !prev);
    }
  }, []);

  const attachVideoFromDevice = useCallback(
    async (file: File | null) => {
      if (!file || !currentExercise) return;
      if (!['video/mp4', 'video/webm'].includes(file.type)) return;
      const rec: MediaBlobRecord = {
        id: uid('media'),
        mimeType: file.type,
        byteLength: file.size,
        sha256: await IndexedDBMediaBlobRepository.sha256(file),
        blob: file,
        ownerType: 'exercise',
        ownerId: currentExercise.id,
        createdAt: Date.now(),
      };
      await mediaRepo.put(rec);
      revokeBlobUrl();
      const url = URL.createObjectURL(rec.blob);
      blobUrlRef.current = url;
      setMediaSource({ kind: 'blob', url, blobId: rec.id });
      eventBus.emit('subtask:completed', { subtask: `media:attach:${currentExercise.id}`, at: new Date().toISOString() });
    },
    [currentExercise, eventBus, mediaRepo, revokeBlobUrl],
  );

  const onAttachInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      void attachVideoFromDevice(file);
      e.target.value = '';
    },
    [attachVideoFromDevice],
  );

  const setLoadUnit = useCallback((unit: 'kg' | 'backpack_books') => {
    setSetState((prev) => {
      if (prev.loadUnit === unit) return prev;
      const kg = toKg(prev.loadKg, prev.loadUnit);
      return { ...prev, loadUnit: unit, loadKg: fromKg(kg, unit) };
    });
  }, []);

  if (!currentExercise || !currentPrescription) {
    return <div className="wp-root wp-empty">No exercise available for this program day.</div>;
  }

  const displayLoad = setState.loadKg;
  const loadStep = setState.loadUnit === 'kg' ? 0.5 : 1;
  const loadLabel = setState.loadUnit === 'kg' ? 'kg' : 'books';
  const progressPct = exerciseOrder.length > 0 ? ((activeExerciseIdx + (activeSetIdx / Math.max(1, totalSets))) / exerciseOrder.length) * 100 : 0;

  return (
    <div className={`wp-root ${isQuiet ? 'wp-quiet' : ''}`} data-theme="arcane-grimoire">
      <header className="wp-header">
        <div className="wp-header-top">
          <div>
            <div className="wp-kicker">NEXUS SINGULARITY / DORM PROTOCOL</div>
            <h2 className="wp-title">{program.title}</h2>
            <div className="wp-subtitle">{resolvedDay.label} · {program.description}</div>
          </div>
          <div className="wp-badges">
            <span className={`wp-badge ${isQuiet ? 'wp-badge-quiet' : ''}`}>{isQuiet ? 'QUIET MODE' : 'AUDIO READY'}</span>
            <span className="wp-badge">RPE CAP {program.rpeCap}</span>
          </div>
        </div>
        <div className="wp-progress" aria-label="Workout progress">
          <div className="wp-progress-bar" style={{ width: `${clamp(progressPct, 0, 100)}%` }} />
        </div>
        <div className="wp-progress-meta">
          <span>Exercise {activeExerciseIdx + 1}/{exerciseOrder.length}</span>
          <span>Set {activeSetIdx + 1}/{totalSets}</span>
        </div>
      </header>

      <main className="wp-card">
        <section className="wp-media-shell" ref={videoShellRef}>
          <div className="wp-media-frame">
            {mediaLoading ? (
              <div className="wp-media-loading">Resolving grimoire media...</div>
            ) : mediaSource.kind === 'blob' || mediaSource.kind === 'local' ? (
              <video
                ref={videoRef}
                className="wp-video"
                src={mediaSource.url}
                playsInline
                loop
                muted
                autoPlay
                preload="metadata"
                onClick={toggleVideoPlayback}
                onPlay={() => setVideoPaused(false)}
                onPause={() => setVideoPaused(true)}
              />
            ) : mediaSource.kind === 'youtube' ? (
              <iframe
                className="wp-video wp-youtube"
                src={mediaSource.url}
                title={`${currentExercise.name} fallback video`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            ) : (
              <BiomechPlaceholder exercise={currentExercise} />
            )}
            {(mediaSource.kind === 'blob' || mediaSource.kind === 'local') && (
              <button type="button" className="wp-overlay-btn" onClick={toggleVideoPlayback} aria-label={videoPaused ? 'Play video' : 'Pause video'}>
                {videoPaused ? '▶' : '❚❚'}
              </button>
            )}
          </div>
          <div className="wp-media-actions">
            {(mediaSource.kind === 'blob' || mediaSource.kind === 'local') && (
              <button type="button" className="wp-btn wp-btn-ghost" onClick={toggleVideoPlayback}>
                {videoPaused ? 'Tap to Play' : 'Tap to Pause'}
              </button>
            )}
            <button type="button" className="wp-btn wp-btn-ghost" onClick={() => void toggleFullscreen()}>
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
            <button type="button" className="wp-btn wp-btn-ghost" onClick={() => attachInputRef.current?.click()}>
              Attach Video from Device
            </button>
            <input
              ref={attachInputRef}
              type="file"
              accept="video/mp4,video/webm"
              className="wp-hidden-input"
              onChange={onAttachInputChange}
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          {mediaSource.kind === 'youtube' && <div className="wp-media-note">Online fallback: YouTube nocookie embed. No offline cache.</div>}
          {mediaSource.kind === 'placeholder' && <div className="wp-media-note">No local media bound. Attach a device video for offline playback.</div>}
        </section>

        <section className="wp-exercise-meta">
          <div className="wp-exercise-head">
            <div>
              <div className="wp-kicker">{currentExercise.type.toUpperCase()} · {currentExercise.muscleGroups.join(' / ')}</div>
              <h3 className="wp-exercise-name">{currentExercise.name}</h3>
            </div>
            <div className="wp-equip">
              {currentExercise.equipmentRequired.map((eq) => (
                <span key={eq} className="wp-equip-chip">{eq.replace(/_/g, ' ')}</span>
              ))}
            </div>
          </div>
          <div className="wp-cues">
            {currentExercise.formCues.map((cue, i) => (
              <div key={`${currentExercise.id}-cue-${i}`} className="wp-cue"><span className="wp-cue-ix">{i + 1}</span><span>{cue}</span></div>
            ))}
          </div>
          <div className="wp-safety">{currentExercise.safetyWarning}</div>
        </section>

        <section className="wp-input-grid" aria-label="Set inputs">
          <div className="wp-input-cell">
            <div className="wp-input-label">SETS</div>
            <div className="wp-stepper">
              <button type="button" className="wp-step-btn" aria-label="Previous set" onClick={() => setActiveSetIdx((s) => clamp(s - 1, 0, totalSets - 1))}>−</button>
              <div className="wp-step-value" aria-live="polite">{activeSetIdx + 1}<span className="wp-step-sub">/{totalSets}</span></div>
              <button type="button" className="wp-step-btn" aria-label="Next set" onClick={() => setActiveSetIdx((s) => clamp(s + 1, 0, totalSets - 1))}>+</button>
            </div>
          </div>

          <div className="wp-input-cell">
            <div className="wp-input-label">REPS</div>
            <div className="wp-stepper">
              <button type="button" className="wp-step-btn" aria-label="Decrease reps" onClick={() => setSetState((p) => ({ ...p, repsCompleted: clamp(p.repsCompleted - 1, 0, 200) }))}>−</button>
              <div className="wp-step-value" aria-live="polite">{setState.repsCompleted}</div>
              <button type="button" className="wp-step-btn" aria-label="Increase reps" onClick={() => setSetState((p) => ({ ...p, repsCompleted: clamp(p.repsCompleted + 1, 0, 200) }))}>+</button>
            </div>
            <div className="wp-target">Target {currentPrescription.targetRepsMin}-{currentPrescription.targetRepsMax}</div>
          </div>

          <div className="wp-input-cell">
            <div className="wp-input-label">LOAD ({loadLabel})</div>
            <div className="wp-stepper">
              <button type="button" className="wp-step-btn" aria-label="Decrease load" onClick={() => setSetState((p) => ({ ...p, loadKg: clamp(Number((p.loadKg - loadStep).toFixed(2)), 0, 500) }))}>−</button>
              <div className="wp-step-value" aria-live="polite">{displayLoad}</div>
              <button type="button" className="wp-step-btn" aria-label="Increase load" onClick={() => setSetState((p) => ({ ...p, loadKg: clamp(Number((p.loadKg + loadStep).toFixed(2)), 0, 500) }))}>+</button>
            </div>
            <div className="wp-load-toggle" role="group" aria-label="Load unit">
              <button type="button" className={`wp-toggle ${setState.loadUnit === 'kg' ? 'wp-toggle-active' : ''}`} onClick={() => setLoadUnit('kg')}>kg</button>
              <button type="button" className={`wp-toggle ${setState.loadUnit === 'backpack_books' ? 'wp-toggle-active' : ''}`} onClick={() => setLoadUnit('backpack_books')}>backpack books</button>
            </div>
          </div>

          <div className="wp-input-cell">
            <div className="wp-input-label">RPE (1-10)</div>
            <div className="wp-stepper">
              <button type="button" className="wp-step-btn" aria-label="Decrease RPE" onClick={() => setSetState((p) => ({ ...p, rpe: clamp(p.rpe - 1, 1, 10) }))}>−</button>
              <div className={`wp-step-value ${overreach ? 'wp-rpe-danger' : ''}`} aria-live="polite">{setState.rpe}</div>
              <button type="button" className="wp-step-btn" aria-label="Increase RPE" onClick={() => setSetState((p) => ({ ...p, rpe: clamp(p.rpe + 1, 1, 10) }))}>+</button>
            </div>
            <div className="wp-target">Cap {currentPrescription.rpeCap} / program {program.rpeCap}</div>
          </div>
        </section>

        {overreach && (
          <div className="wp-overreach" role="alert" aria-live="assertive">
            <div className="wp-overreach-title">WARRIOR-190 OVERREACH WARNING</div>
            <div className="wp-overreach-body">RPE {setState.rpe} exceeds cap 8. Reduce load, reps, or stop the set. No 1RM. No ego lifting.</div>
          </div>
        )}

        <section className="wp-actions">
          <button type="button" className="wp-btn wp-btn-primary" onClick={commitSet} disabled={!!finishedLog}>
            {activeSetIdx + 1 < totalSets ? 'Complete Set & Rest' : activeExerciseIdx + 1 < exerciseOrder.length ? 'Complete Set & Next Exercise' : 'Complete Final Set'}
          </button>
          <button
            type="button"
            className="wp-btn wp-btn-swap"
            onClick={swapExercise}
            disabled={!currentExercise.swapAlternativeId || !exerciseMap.has(currentExercise.swapAlternativeId) || !!finishedLog}
          >
            1-Tap Swap Exercise
          </button>
          <button
            type="button"
            className="wp-btn wp-btn-danger"
            onClick={() => abortForSafety('illness')}
            disabled={!!finishedLog}
          >
            Illness / Joint Pain Stop Flag
          </button>
          <button
            type="button"
            className="wp-btn wp-btn-danger-sub"
            onClick={() => abortForSafety('joint_pain')}
            disabled={!!finishedLog}
          >
            Report Joint Pain (Stop + Shield)
          </button>
        </section>

        <section className={`wp-rest ${restRunning ? 'wp-rest-running' : ''} ${isQuiet ? 'wp-rest-quiet' : ''}`} aria-label="Rest timer">
          <div className="wp-rest-head">
            <div>
              <div className="wp-kicker">REST TIMER</div>
              <div className="wp-rest-time">{formatTime(restRemaining ?? restSeconds)}</div>
            </div>
            <div className="wp-rest-mode">{isQuiet ? 'Silent vibration + visual edge pulse' : 'Audio + vibration alerts'}</div>
          </div>
          <div className="wp-rest-controls">
            <button type="button" className="wp-btn wp-btn-ghost" onClick={() => adjustRest(-15)}>-15s</button>
            <button type="button" className="wp-btn wp-btn-ghost" onClick={() => adjustRest(15)}>+15s</button>
            <button type="button" className="wp-btn wp-btn-ghost" onClick={startRest} disabled={!!finishedLog}>Start</button>
            <button type="button" className="wp-btn wp-btn-ghost" onClick={stopRest}>Skip</button>
          </div>
          {restRunning && isQuiet && <div className="wp-rest-pulse" aria-hidden="true" />}
        </section>

        {finishedLog && (
          <section className="wp-finish" aria-live="polite">
            <div className="wp-finish-title">{finishedLog.abortedForSafety ? 'SESSION SAFELY ABORTED' : 'WORKOUT COMPLETE'}</div>
            <div className="wp-finish-xp">XP SUMMARY: +{xpSummary ?? 0} XP</div>
            <div className="wp-finish-stats">
              <span>Sets: {finishedLog.sets.filter((s) => s.completed).length}</span>
              <span>Max RPE: {finishedLog.maxRpeReported}</span>
              <span>Shield: {finishedLog.abortedForSafety ? 'ACTIVE' : 'STANDBY'}</span>
            </div>
            <div className="wp-finish-id">Log {finishedLog.id} · {finishedLog.date}</div>
          </section>
        )}
      </main>
    </div>
  );
};

export default WorkoutPlayer;
