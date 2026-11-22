import type { Task } from '../core/types';
import { openNexusDb, putRecord, getRecord, getAllRecords, getByIndex, deleteRecord } from '../core/db/db';

export interface TaskRepository {
  create(task: Task): Promise<string>;
  update(id: string, updates: Partial<Task>): Promise<void>;
  getById(id: string): Promise<Task | undefined>;
  listByIndex(index: string, value: IDBValidKey): Promise<Task[]>;
  listAll(): Promise<Task[]>;
  delete(id: string): Promise<void>;
}

export class IndexedDBTaskRepository implements TaskRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async create(task: Task): Promise<string> {
    const db = await this.db();
    const id = task.id || crypto.randomUUID();
    await putRecord(db, 'tasks', { ...task, id });
    return id;
  }

  async update(id: string, updates: Partial<Task>): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<Task>(db, 'tasks', id);
    if (!rec) throw new Error(`Task not found: ${id}`);
    await putRecord(db, 'tasks', { ...rec, ...updates, id });
  }

  async getById(id: string): Promise<Task | undefined> {
    const db = await this.db();
    return getRecord<Task>(db, 'tasks', id);
  }

  async listByIndex(index: string, value: IDBValidKey): Promise<Task[]> {
    const db = await this.db();
    return getByIndex<Task>(db, 'tasks', index, value);
  }

  async listAll(): Promise<Task[]> {
    const db = await this.db();
    return getAllRecords<Task>(db, 'tasks');
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, 'tasks', id);
  }
}

export const taskRepository = new IndexedDBTaskRepository();
