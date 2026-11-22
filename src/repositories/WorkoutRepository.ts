import type { WorkoutProgram } from '../core/types';
import { openNexusDb, putRecord, getRecord, getAllRecords, getByIndex, deleteRecord } from '../core/db/db';

export interface WorkoutRepository {
  create(program: WorkoutProgram): Promise<string>;
  update(id: string, updates: Partial<WorkoutProgram>): Promise<void>;
  getById(id: string): Promise<WorkoutProgram | undefined>;
  listByIndex(index: string, value: IDBValidKey): Promise<WorkoutProgram[]>;
  listAll(): Promise<WorkoutProgram[]>;
  delete(id: string): Promise<void>;
  listByDateRange(from: string, to: string): Promise<WorkoutProgram[]>;
}

export class IndexedDBWorkoutRepository implements WorkoutRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async create(program: WorkoutProgram): Promise<string> {
    const db = await this.db();
    const id = program.id || crypto.randomUUID();
    await putRecord(db, 'workout_programs', { ...program, id });
    return id;
  }

  async update(id: string, updates: Partial<WorkoutProgram>): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<WorkoutProgram>(db, 'workout_programs', id);
    if (!rec) throw new Error(`WorkoutProgram not found: ${id}`);
    await putRecord(db, 'workout_programs', { ...rec, ...updates, id });
  }

  async getById(id: string): Promise<WorkoutProgram | undefined> {
    const db = await this.db();
    return getRecord<WorkoutProgram>(db, 'workout_programs', id);
  }

  async listByIndex(index: string, value: IDBValidKey): Promise<WorkoutProgram[]> {
    const db = await this.db();
    return getByIndex<WorkoutProgram>(db, 'workout_programs', index, value);
  }

  async listAll(): Promise<WorkoutProgram[]> {
    const db = await this.db();
    return getAllRecords<WorkoutProgram>(db, 'workout_programs');
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, 'workout_programs', id);
  }

  async listByDateRange(from: string, to: string): Promise<WorkoutProgram[]> {
    const all = await this.listAll();
    return all.filter((p) => p.created >= from && p.created <= to);
  }
}

export const workoutRepository = new IndexedDBWorkoutRepository();
