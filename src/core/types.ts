// Shared domain types (ARCHITECTURE_BLUEPRINT_V2 § CORE INTERFACES).
// erasableSyntaxOnly: unions + as const objects only — no enums.

export type EnergyTag = 'Red' | 'Yellow' | 'Green';
export type DateKey = string; // ISO 8601
export type TimestampMs = number;
export type EntityId = string;
export type PriorityLevel = 'low' | 'medium' | 'high' | 'critical';
export type DormEquipment = 'bodyweight' | 'dumbbell_2kg_pair' | 'yoga_mat' | 'loadable_backpack';

export interface LifeArea { id: string; name: string; color: 'Red' | 'Yellow' | 'Green'; goals: string[]; canvasX?: number; canvasY?: number }
export interface Goal { id: string; title: string; description: string; lifeAreaId: string; projects: string[]; tags: string[] }
export interface Project { id: string; title: string; goalId: string; milestones: string[]; status: 'active' | 'paused' | 'completed' }
export interface Milestone { id: string; title: string; projectId: string; tasks: string[]; completedTasks: string[]; deadline?: string }
export interface Task { id: string; title: string; description: string; projectId: string; subtasks: string[]; blockedBy: string[]; energyTag: EnergyTag; dueDate?: string; wikiLinks: string[]; progress: number }
export interface Subtask { id: string; title: string; taskId: string; completed: boolean; progress?: number }
export interface DailyHabit { id: string; title: string; completed: boolean; progress: number; lastCompleted?: string; energyTag: EnergyTag; canvasX?: number; canvasY?: number }
export interface Note { id: string; title: string; content: string; created: string; modified: string; backlinks: string[]; dailyJournal?: string; morningRitualSnapshot?: string; ordersForTomorrowSnapshot?: string }
export interface ObsidianSyncQueueItem { id: string; endpoint: string; payload: unknown; retryCount: number; created: string; lastAttempt: string; status: 'pending' | 'sent' | 'failed' }
export interface CryptoKeyRecord { id: string; algorithm: string; created: string }
export interface EncryptedTokenEnvelope { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }
export interface ScheduleBlock { id: string; type: 'lesson' | 'timeblock' | 'break'; title: string; subject?: string; startTime: string; endTime: string; daysOfWeek: number[]; gradeLevel?: string; room?: string }
export interface CharacterProfile { id: string; name: string; level: number; stats: Record<string, { level: number; xp: number; xpToNext: number }>; experience: number; nextLevelXp: number }
export interface SkillSubTechniques { masteryPct: number; tier: 0 | 1 | 2 | 3 }
export interface SkillNode { id: string; title: string; description: string; parentSkillId?: string; subTechniques: SkillSubTechniques[]; unlocked: boolean; xp: number }
export interface EnergyBatteries { Physical: number; Emotional: number; Mental: number; Spiritual: number; averageEnergy: number; yerkesDodsonMultiplier: number; sleepDebtHours: number; activeIllnessFlag: boolean; jointPainFlag: boolean }
export interface RecoveryShieldState { active: boolean; reasons: string[]; lastTriggered?: string; freezeStreak: boolean; convertedQuestIds: string[]; quietModeSuggested: boolean }
export interface XpTransaction { id: string; type: 'gain' | 'spend'; amount: number; reason: string; timestamp: string; relatedEntity: 'task' | 'quest' | 'level'; deltaProgressPct: number; baseXp: number; priorityMultiplier: number; comboMultiplier: number; diminishingFactor: number; yerkesDodsonMultiplier: number; finalXp: number; statAllocations: Record<string, number> }
export interface WorkoutProgram { id: string; title: string; description: string; exercises: string[]; created: string; rpeCap: 8; allow1RM: false; forbidHeadNeckBridges: true; days: WorkoutDay[] }
export interface WorkoutDay { targetSets: number; targetRepsMin: number; targetRepsMax: number; loadKg: number; tempo: string }
export interface ExerciseDefinition { id: string; name: string; type: 'strength' | 'cardio' | 'mobility'; muscleGroups: string[]; equipmentRequired: DormEquipment[]; isSilentLowImpact: boolean; isHeadNeckBridge: boolean; defaultRpeCap: 8; formCues: string[]; safetyWarning: string; swapAlternativeId?: string | null; mediaBlobId?: string }
export interface WorkoutLog { id: string; programId: string; date: string; sets: WorkoutSet[]; maxRpeReported: number; illnessStopFlag: boolean; jointPainStopFlag: boolean; abortedForSafety: boolean }
export interface WorkoutSet { rpe: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10; durationSeconds?: number; completed: boolean }
export interface BodyMetrics { id: string; date: string; weight: number; bodyFat?: number; muscleMass?: number; restingHeartRate?: number; sleepHours: number; sleepQuality: 1 | 2 | 3 | 4 | 5; soreness: 1 | 2 | 3 | 4 | 5; tonsilPainFlag: boolean; jointPainAreas: string[]; girths: Record<string, number> }
export type MediaBlobOwnerType = 'user' | 'quest' | 'level' | 'exercise';
export interface MediaBlobRecord { id: string; mimeType: string; byteLength: number; sha256: string; blob: Blob; ownerType: MediaBlobOwnerType; ownerId: string; createdAt: number }
