import type { Note } from '../core/types';
import { openNexusDb, putRecord, getRecord, getAllRecords, getByIndex, deleteRecord } from '../core/db/db';

export interface NoteRepository {
  create(note: Note): Promise<string>;
  update(id: string, updates: Partial<Note>): Promise<void>;
  getById(id: string): Promise<Note | undefined>;
  listByIndex(index: string, value: IDBValidKey): Promise<Note[]>;
  listAll(): Promise<Note[]>;
  delete(id: string): Promise<void>;
}

export class IndexedDBNoteRepository implements NoteRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async create(note: Note): Promise<string> {
    const db = await this.db();
    const id = note.id || crypto.randomUUID();
    await putRecord(db, 'notes', { ...note, id });
    return id;
  }

  async update(id: string, updates: Partial<Note>): Promise<void> {
    const db = await this.db();
    const rec = await getRecord<Note>(db, 'notes', id);
    if (!rec) throw new Error(`Note not found: ${id}`);
    await putRecord(db, 'notes', { ...rec, ...updates, id, modified: new Date().toISOString() });
  }

  async getById(id: string): Promise<Note | undefined> {
    const db = await this.db();
    return getRecord<Note>(db, 'notes', id);
  }

  async listByIndex(index: string, value: IDBValidKey): Promise<Note[]> {
    const db = await this.db();
    return getByIndex<Note>(db, 'notes', index, value);
  }

  async listAll(): Promise<Note[]> {
    const db = await this.db();
    return getAllRecords<Note>(db, 'notes');
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, 'notes', id);
  }
}

export const noteRepository = new IndexedDBNoteRepository();
