// Typed pub/sub per blueprint §EVENTBUS (9 events). Handler errors isolated.

export const EVENT_TYPES = {
  subtaskCompleted: 'subtask:completed',
  questUnlocked: 'quest:unlocked',
  ordersSealed: 'orders:sealed',
  energyUpdated: 'energy:updated',
  shieldActivated: 'shield:activated',
  workoutFinished: 'workout:finished',
  levelUp: 'level:up',
  quietModeChanged: 'quietMode:changed',
  syncQueued: 'sync:queued',
} as const;

export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

export interface EventPayloadMap {
  'subtask:completed': { subtaskId: string; taskId: string; completed: boolean };
  'quest:unlocked': { questId: string; entityId: string };
  'orders:sealed': { orderId: string; entityId: string; sealedAt: string };
  'energy:updated': { entityId: string; oldEnergy: number; newEnergy: number; source: 'task' | 'quest' | 'level' | 'habit' };
  'shield:activated': { entityId: string; active: boolean; reason?: string };
  'workout:finished': { workoutId: string; entityId: string; completedAt: string };
  'level:up': { entityId: string; oldLevel: number; newLevel: number; xgained: number };
  'quietMode:changed': { quietMode: boolean; entityId?: string };
  'sync:queued': { queueItemId: string; endpoint: string; payload: unknown };
}

export type NexusEventHandler<T extends EventType> = (payload: EventPayloadMap[T]) => void;

type AnyHandler = (payload: never) => void;

export class NexusEventBus {
  private handlers = new Map<EventType, Set<AnyHandler>>();

  on<T extends EventType>(type: T, handler: NexusEventHandler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as AnyHandler);
    return () => this.off(type, handler);
  }

  off<T extends EventType>(type: T, handler: NexusEventHandler<T>): void {
    this.handlers.get(type)?.delete(handler as unknown as AnyHandler);
  }

  emit<T extends EventType>(type: T, payload: EventPayloadMap[T]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as unknown as NexusEventHandler<T>)(payload);
      } catch (err) {
        console.error(`[eventbus] handler failed for ${type}`, err);
      }
    }
  }
}

export const eventBus = new NexusEventBus();
