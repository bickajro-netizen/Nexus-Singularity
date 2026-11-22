// IDB 'nexus-singularity' v4 — 22 stores, index topology per blueprint §STORE SCHEMAS.
// Single-writer rule lives in the repositories; db.ts only opens/upgrade/helpers.

export const DB_NAME = 'nexus-singularity';
export const DB_VERSION = 4;

export interface IndexSpec { fields: string[]; unique?: boolean; multiEntry?: boolean }
export interface StoreSchema { keyPath: 'id'; indexes: IndexSpec[] }

export const STORE_NAMES = [
  'app_meta', 'life_areas', 'goals', 'projects', 'milestones', 'tasks', 'subtasks',
  'daily_habits', 'notes', 'obsidian_sync_queue', 'crypto_keystore', 'schedule_blocks',
  'character_profile', 'skill_nodes', 'energy_batteries', 'recovery_shield',
  'xp_transactions', 'workout_programs', 'exercise_definitions', 'workout_logs',
  'body_metrics', 'media_blobs',
] as const;
export type StoreName = typeof STORE_NAMES[number];

const ix = (fields: string[], flags: { unique?: boolean; multiEntry?: boolean } = {}): IndexSpec => ({ fields, ...flags });

export const STORE_SCHEMAS: Record<StoreName, StoreSchema> = {
  app_meta: { keyPath: 'id', indexes: [] },
  life_areas: { keyPath: 'id', indexes: [ix(['name'], { unique: true }), ix(['color'])] },
  goals: { keyPath: 'id', indexes: [ix(['lifeAreaId']), ix(['tags'], { multiEntry: true })] },
  projects: { keyPath: 'id', indexes: [ix(['goalId']), ix(['status'])] },
  milestones: { keyPath: 'id', indexes: [ix(['projectId']), ix(['deadline'])] },
  tasks: { keyPath: 'id', indexes: [ix(['projectId']), ix(['blocked_by'], { multiEntry: true }), ix(['wikiLinks'], { multiEntry: true }), ix(['energyTag'])] },
  subtasks: { keyPath: 'id', indexes: [ix(['taskId']), ix(['completed'])] },
  daily_habits: { keyPath: 'id', indexes: [ix(['energyTag']), ix(['canvasX']), ix(['canvasY'])] },
  notes: { keyPath: 'id', indexes: [ix(['created']), ix(['modified']), ix(['backlinks'], { multiEntry: true })] },
  obsidian_sync_queue: { keyPath: 'id', indexes: [ix(['status']), ix(['retryCount'])] },
  crypto_keystore: { keyPath: 'id', indexes: [ix(['key'], { unique: true })] },
  schedule_blocks: { keyPath: 'id', indexes: [ix(['type']), ix(['daysOfWeek'], { multiEntry: true }), ix(['startMinutes']), ix(['endMinutes']), ix(['isTemplate']), ix(['grades'])] },
  character_profile: { keyPath: 'id', indexes: [] },
  skill_nodes: { keyPath: 'id', indexes: [ix(['parentSkillId']), ix(['unlocked'])] },
  energy_batteries: { keyPath: 'id', indexes: [ix(['averageEnergy']), ix(['yerkesDodsonMultiplier']), ix(['sleepDebtHours']), ix(['activeIllnessFlag']), ix(['jointPainFlag'])] },
  recovery_shield: { keyPath: 'id', indexes: [ix(['reasons'], { multiEntry: true }), ix(['quietModeSuggested'])] },
  xp_transactions: { keyPath: 'id', indexes: [ix(['type']), ix(['timestamp']), ix(['relatedEntity'])] },
  workout_programs: { keyPath: 'id', indexes: [ix(['created']), ix(['rpeCap'])] },
  exercise_definitions: { keyPath: 'id', indexes: [ix(['type']), ix(['muscleGroups'], { multiEntry: true }), ix(['equipmentRequired'], { multiEntry: true })] },
  workout_logs: { keyPath: 'id', indexes: [ix(['programId']), ix(['date'])] },
  body_metrics: { keyPath: 'id', indexes: [ix(['date'])] },
  media_blobs: { keyPath: 'id', indexes: [ix(['mimeType']), ix(['sha256'], { unique: true }), ix(['ownerType']), ix(['ownerId'])] },
};

export function indexName(spec: IndexSpec): string {
  return spec.fields.join('_');
}

let openPromise: Promise<IDBDatabase> | null = null;

export function openNexusDb(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        if (db.objectStoreNames.contains(name)) continue;
        const schema = STORE_SCHEMAS[name];
        const store = db.createObjectStore(name, { keyPath: schema.keyPath });
        for (const spec of schema.indexes) {
          // multiEntry indexes a record's array field → keyPath must be the single
          // field string (array keyPath + multiEntry throws InvalidAccessError).
          const keyPath = spec.multiEntry ? spec.fields[0] : (spec.fields.length === 1 ? spec.fields[0] : spec.fields);
          store.createIndex(indexName(spec), keyPath, { unique: !!spec.unique, multiEntry: !!spec.multiEntry });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { openPromise = null; reject(req.error ?? new Error('IDB open failed')); };
  });
  return openPromise;
}

export function openTransaction(db: IDBDatabase, names: readonly StoreName[], mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(names as unknown as string[], mode);
}

/** Run a request-producing fn inside a fresh transaction; resolves with the request result on tx complete. */
export function withStore<T>(
  db: IDBDatabase,
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = openTransaction(db, [name], mode);
    const store = tx.objectStore(name);
    let result: T;
    try {
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error ?? new Error('IDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB tx aborted'));
  });
}

export function putRecord(db: IDBDatabase, store: StoreName, value: unknown): Promise<void> {
  return withStore<void>(db, store, 'readwrite', (s) => { s.put(value); });
}

export function getRecord<T>(db: IDBDatabase, store: StoreName, id: string): Promise<T | undefined> {
  return withStore<T | undefined>(db, store, 'readonly', (s) => s.get(id));
}

export function getAllRecords<T>(db: IDBDatabase, store: StoreName): Promise<T[]> {
  return withStore<T[]>(db, store, 'readonly', (s) => s.getAll());
}

export function getByIndex<T>(db: IDBDatabase, store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  return withStore<T[]>(db, store, 'readonly', (s) => s.index(index).getAll(value));
}

export function deleteRecord(db: IDBDatabase, store: StoreName, id: string): Promise<void> {
  return withStore<void>(db, store, 'readwrite', (s) => { s.delete(id); });
}
