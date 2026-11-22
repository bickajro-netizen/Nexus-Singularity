import type { ObsidianSyncQueueItem } from '../core/types';
import { openNexusDb, putRecord, getRecord, getAllRecords, getByIndex, deleteRecord } from '../core/db/db';

export interface SyncQueueRepository {
  create(item: ObsidianSyncQueueItem): Promise<string>;
  update(id: string, updates: Partial<ObsidianSyncQueueItem>): Promise<void>;
  getById(id: string): Promise<ObsidianSyncQueueItem | undefined>;
  listByIndex(index: string, value: IDBValidKey): Promise<ObsidianSyncQueueItem[]>;
  listAll(): Promise<ObsidianSyncQueueItem[]>;
  delete(id: string): Promise<void>;
  markSent(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  listPending(): Promise<ObsidianSyncQueueItem[]>;
}

export class IndexedDBSyncQueueRepository implements SyncQueueRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async create(item: ObsidianSyncQueueItem): Promise<string> {
    const db = await this.db();
    const id = item.id || crypto.randomUUID();
    await putRecord(db, 'obsidian_sync_queue', { ...item, id });
    return id;
  }

  async update(id: string, updates: Partial<ObsidianSyncQueueItem>): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<ObsidianSyncQueueItem>(db, 'obsidian_sync_queue', id);
    if (!rec) throw new Error(`SyncQueueItem not found: ${id}`);
    await putRecord(db, 'obsidian_sync_queue', { ...rec, ...updates, id });
  }

  async getById(id: string): Promise<ObsidianSyncQueueItem | undefined> {
    const db = await this.db();
    return getRecord<ObsidianSyncQueueItem>(db, 'obsidian_sync_queue', id);
  }

  async listByIndex(index: string, value: IDBValidKey): Promise<ObsidianSyncQueueItem[]> {
    const db = await this.db();
    return getByIndex<ObsidianSyncQueueItem>(db, 'obsidian_sync_queue', index, value);
  }

  async listAll(): Promise<ObsidianSyncQueueItem[]> {
    const db = await this.db();
    return getAllRecords<ObsidianSyncQueueItem>(db, 'obsidian_sync_queue');
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, 'obsidian_sync_queue', id);
  }

  async markSent(id: string): Promise<void> {
    await this.update(id, { status: 'sent', lastAttempt: new Date().toISOString() });
  }

  async markFailed(id: string): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<ObsidianSyncQueueItem>(db, 'obsidian_sync_queue', id);
    if (!rec) throw new Error(`SyncQueueItem not found: ${id}`);
    await putRecord(db, 'obsidian_sync_queue', {
      ...rec,
      status: 'failed',
      retryCount: (rec.retryCount ?? 0) + 1,
      lastAttempt: new Date().toISOString(),
    });
  }

  async listPending(): Promise<ObsidianSyncQueueItem[]> {
    return this.listByIndex('status', 'pending');
  }
}

export const syncQueueRepository = new IndexedDBSyncQueueRepository();
