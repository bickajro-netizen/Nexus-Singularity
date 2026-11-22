export interface EventBus<T extends Record<string, unknown>> {
  on<K extends keyof T & string>(event: K, handler: (payload: T[K]) => void): () => void;
  emit<K extends keyof T & string>(event: K, payload: T[K]): void;
}

export type AudioEffect =
  | 'subtask_tick'
  | 'level_up'
  | 'skill_unlock'
  | 'workout_start'
  | 'shield_activate'
  | 'orders_sealed'
  | 'error_warning';

export type HapticPattern = 'subtask_complete' | 'level_up' | 'error_warning';

export interface VoiceCommandResult {
  matched: boolean;
  intent: string | null;
  params: Record<string, string>;
  rawTranscript: string;
}

export interface NexusEventMap {
  'subtask:completed': { subtaskId?: string };
  'quest:unlocked': { questId?: string };
  'orders:sealed': { noteId?: string };
  'energy:updated': { value: number };
  'shield:activated': { duration?: number };
  'workout:finished': { workoutId?: string };
  'level:up': { newLevel: number };
  'quietMode:changed': { enabled: boolean };
  'sync:queued': { itemId?: string };
  [key: string]: unknown;
}

export class VoiceAndAudioEngine {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private buffers: Map<AudioEffect, AudioBuffer> = new Map();
  private isQuietMode: boolean = false;
  private isUnlocked: boolean = false;
  private edgePulseActive: boolean = false;
  private eventBus: EventBus<NexusEventMap>;
  private unsubscribeFns: Array<() => void> = [];

  private static readonly SOUND_FILES: Record<AudioEffect, string> = {
    subtask_tick: 'subtask_tick.wav',
    level_up: 'level_up.wav',
    skill_unlock: 'skill_unlock.wav',
    workout_start: 'workout_start.wav',
    shield_activate: 'shield_activate.wav',
    orders_sealed: 'orders_sealed.wav',
    error_warning: 'error_warning.wav'
  };

  private static readonly HAPTIC_TIMINGS: Record<HapticPattern, number[]> = {
    subtask_complete: [40],
    level_up: [100, 50, 100, 50, 200],
    error_warning: [200, 100, 200]
  };

  constructor(eventBus: EventBus<NexusEventMap>) {
    this.eventBus = eventBus;
    this.checkAutoQuietMode();
    this.initAudioContext();
    this.bindUnlockListeners();
    this.preloadSounds();
    this.subscribeEvents();
  }

  public get quietMode(): boolean {
    return this.isQuietMode;
  }

  public get edgePulse(): boolean {
    return this.edgePulseActive;
  }

  public setQuietMode(enabled: boolean): void {
    this.isQuietMode = enabled;
    if (this.masterGain && this.audioCtx) {
      this.masterGain.gain.setValueAtTime(enabled ? 0.0 : 0.75, this.audioCtx.currentTime);
    }
    if (enabled && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.edgePulseActive = enabled;
  }

  public async playEffect(effect: AudioEffect): Promise<void> {
    if (this.isQuietMode || !this.audioCtx || !this.masterGain) return;
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    const buffer = this.buffers.get(effect);
    if (!buffer) return;

    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);
    source.start(0);
  }

  public speakBriefing(text: string): void {
    if (this.isQuietMode) return;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }

  public triggerHaptic(pattern: HapticPattern): void {
    if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
    const timings = VoiceAndAudioEngine.HAPTIC_TIMINGS[pattern];
    if (timings) {
      navigator.vibrate(timings);
    }
  }

  public parseVoiceCommand(transcript: string): VoiceCommandResult {
    const raw = transcript.trim();
    if (!raw) {
      return { matched: false, intent: null, params: {}, rawTranscript: raw };
    }

    const ctrlKMatch = raw.match(/^(buy|create|add)\s+(.+?)(?:\s+@(\S+))?(?:\s+#(\S+))?(?:\s+\^(\S+))?$/i);
    if (ctrlKMatch) {
      return {
        matched: true,
        intent: 'create_task',
        params: {
          title: ctrlKMatch[2],
          due: ctrlKMatch[3] || '',
          tag: ctrlKMatch[4] || '',
          priority: ctrlKMatch[5] || ''
        },
        rawTranscript: raw
      };
    }

    const navMatch = raw.match(/^(?:nav:|go\s+to|navigate\s+to)\s*(now|brain|hero|energy)$/i);
    if (navMatch) {
      return {
        matched: true,
        intent: 'navigate',
        params: { targetView: navMatch[1].toLowerCase() },
        rawTranscript: raw
      };
    }

    const workoutMatch = raw.match(/^(?:action:|start|begin)\s*(?:workout|training)$/i);
    if (workoutMatch) {
      return { matched: true, intent: 'start_workout', params: {}, rawTranscript: raw };
    }

    const shieldMatch = raw.match(/^(?:action:|activate|enable)\s*shield$/i);
    if (shieldMatch) {
      return { matched: true, intent: 'activate_shield', params: {}, rawTranscript: raw };
    }

    const sealMatch = raw.match(/^(?:action:|seal|lock)\s*orders$/i);
    if (sealMatch) {
      return { matched: true, intent: 'seal_orders', params: {}, rawTranscript: raw };
    }

    const quietMatch = raw.match(/^(?:dorm|quiet)\s*mode\s*(on|off|enable|disable)$/i);
    if (quietMatch) {
      const state = quietMatch[1].toLowerCase();
      const enabled = state === 'on' || state === 'enable';
      return {
        matched: true,
        intent: 'toggle_quiet_mode',
        params: { enabled: String(enabled) },
        rawTranscript: raw
      };
    }

    const subtaskMatch = raw.match(/^(?:check|complete|done)\s+subtask\s+(\d+)$/i);
    if (subtaskMatch) {
      return {
        matched: true,
        intent: 'check_subtask',
        params: { index: subtaskMatch[1] },
        rawTranscript: raw
      };
    }

    return { matched: false, intent: null, params: {}, rawTranscript: raw };
  }

  public destroy(): void {
    this.unsubscribeFns.forEach((fn) => fn());
    this.unsubscribeFns = [];
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  private initAudioContext(): void {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    this.audioCtx = new AudioContextClass();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.setValueAtTime(this.isQuietMode ? 0.0 : 0.75, this.audioCtx.currentTime);
    this.masterGain.connect(this.audioCtx.destination);
  }

  private bindUnlockListeners(): void {
    const unlock = async () => {
      if (this.isUnlocked || !this.audioCtx) return;
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
      this.isUnlocked = true;
      ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
        window.removeEventListener(evt, unlock);
      });
    };

    ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
      window.addEventListener(evt, unlock, { passive: true });
    });
  }

  private async preloadSounds(): Promise<void> {
    if (!this.audioCtx) return;
    const entries = Object.entries(VoiceAndAudioEngine.SOUND_FILES) as Array<[AudioEffect, string]>;
    await Promise.all(
      entries.map(async ([effect, fileName]) => {
        try {
          const resp = await fetch(`/audio/${fileName}`);
          if (!resp.ok) return;
          const arrayBuf = await resp.arrayBuffer();
          if (!this.audioCtx) return;
          const decoded = await this.audioCtx.decodeAudioData(arrayBuf);
          this.buffers.set(effect, decoded);
        } catch {
          // Audio fetch or decode failed gracefully
        }
      })
    );
  }

  private subscribeEvents(): void {
    this.unsubscribeFns.push(
      this.eventBus.on('subtask:completed', () => {
        this.playEffect('subtask_tick');
        this.triggerHaptic('subtask_complete');
      }),
      this.eventBus.on('quest:unlocked', () => {
        this.playEffect('skill_unlock');
      }),
      this.eventBus.on('orders:sealed', () => {
        this.playEffect('shield_activate');
      }),
      this.eventBus.on('shield:activated', () => {
        this.playEffect('shield_activate');
      }),
      this.eventBus.on('workout:finished', () => {
        this.playEffect('workout_start');
      }),
      this.eventBus.on('level:up', () => {
        this.playEffect('level_up');
        this.triggerHaptic('level_up');
      }),
      this.eventBus.on('quietMode:changed', (payload) => {
        this.setQuietMode(payload.enabled);
      })
    );
  }

  private checkAutoQuietMode(): void {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentMins = hours * 60 + minutes;

    const startQuiet = 22 * 60; // 22:00
    const endQuiet = 6 * 60 + 30; // 06:30

    if (currentMins >= startQuiet || currentMins < endQuiet) {
      this.setQuietMode(true);
    }
  }
}
