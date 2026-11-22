import type { MediaBlobRecord } from './contracts';

export type { MediaBlobRecord };

// 22.11 integration: consolidated on the unified nexus-singularity v4 store
// 'media_blobs' (core/db). Previously a private v1 DB with store 'mediaBlobs' —
// opening v1 after v4 throws VersionError, so all repos must share openNexusDb().

import { openNexusDb, putRecord, getRecord, getAllRecords, deleteRecord, getByIndex } from '../core/db/db';

export interface MediaBlobRepository {
  get(id: string): Promise<MediaBlobRecord | undefined>;
  put(record: MediaBlobRecord): Promise<void>;
  delete(id: string): Promise<void>;
  getByOwner(ownerType: MediaBlobRecord['ownerType'], ownerId: string): Promise<MediaBlobRecord[]>;
  listAll(): Promise<MediaBlobRecord[]>;
}

const STORE = 'media_blobs' as const;

export class IndexedDBMediaBlobRepository implements MediaBlobRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  async get(id: string): Promise<MediaBlobRecord | undefined> {
    const db = await this.db();
    return getRecord<MediaBlobRecord>(db, STORE, id);
  }

  async put(record: MediaBlobRecord): Promise<void> {
    const db = await this.db();
    await putRecord(db, STORE, record);
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await deleteRecord(db, STORE, id);
  }

  async getByOwner(ownerType: MediaBlobRecord['ownerType'], ownerId: string): Promise<MediaBlobRecord[]> {
    const db = await this.db();
    const byType = await getByIndex<MediaBlobRecord>(db, STORE, 'ownerType', ownerType);
    return byType.filter((rec) => rec.ownerId === ownerId);
  }

  async listAll(): Promise<MediaBlobRecord[]> {
    const db = await this.db();
    return getAllRecords<MediaBlobRecord>(db, STORE);
  }

  static async sha256(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
    return sha256Hex(input);
  }
}

async function sha256Hex(input: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buf =
    input instanceof Blob
      ? await input.arrayBuffer()
      : input instanceof Uint8Array
        ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
        : input;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 2166136261;
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, '0')}-${bytes.length}`;
}

export const mediaBlobRepository = new IndexedDBMediaBlobRepository();
