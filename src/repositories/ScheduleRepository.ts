import type { ScheduleBlock } from '../core/types';
import { openNexusDb, putRecord, getRecord, getAllRecords, getByIndex, deleteRecord } from '../core/db/db';

export interface ScheduleRepository {
  create(block: ScheduleBlock): Promise<string>;
  update(id: string, updates: Partial<ScheduleBlock>): Promise<void>;
  getById(id: string): Promise<ScheduleBlock | undefined>;
  listByIndex(index: string, value: IDBValidKey): Promise<ScheduleBlock[]>;
  listAll(): Promise<ScheduleBlock[]>;
  delete(id: string): Promise<void>;
  listForDays(days: number[]): Promise<ScheduleBlock[]>;
}

export class IndexedDBScheduleRepository implements ScheduleRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async create(block: ScheduleBlock): Promise<string> {
    const db = await this.db();
    const id = block.id || crypto.randomUUID();
    await putRecord(db, 'schedule_blocks', { ...block, id });
    return id;
  }

  async update(id: string, updates: Partial<ScheduleBlock>): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<ScheduleBlock>(db, 'schedule_blocks', id);
    if (!rec) throw new Error(`ScheduleBlock not found: ${id}`);
    await putRecord(db, 'schedule_blocks', { ...rec, ...updates, id });
  }

  async getById(id: string): Promise<ScheduleBlock | undefined> {
    const db = await this.db();
    return getRecord<ScheduleBlock>(db, 'schedule_blocks', id);
  }

  async listByIndex(index: string, value: IDBValidKey): Promise<ScheduleBlock[]> {
    const db = await this.db();
    return getByIndex<ScheduleBlock>(db, 'schedule_blocks', index, value);
  }

  async listAll(): Promise<ScheduleBlock[]> {
    const db = await this.db();
    return getAllRecords<ScheduleBlock>(db, 'schedule_blocks');
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, 'schedule_blocks', id);
  }

  async listForDays(days: number[]): Promise<ScheduleBlock[]> {
    const all = await this.listAll();
    return all.filter((block) => block.daysOfWeek.some((d) => days.includes(d)));
  }
}

export const scheduleRepository = new IndexedDBScheduleRepository();
