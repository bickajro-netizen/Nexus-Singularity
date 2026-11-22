export interface Note {
  id: string;
  title: string;
  bodyMd: string;
  noteType: 'standard' | 'daily_journal' | 'morning_ritual' | 'orders_for_tomorrow' | 'sleep_rest_log';
  dateKey?: string | null;
  wikiLinks: string[];
  backlinks: string[];
  tags: string[];
  contentHash: string;
  obsidianPath?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ObsidianSyncQueueItem {
  id: string;
  noteId: string;
  method: 'PUT' | 'POST' | 'DELETE';
  endpoint: string;
  bodyMarkdown: string;
  payloadHash: string;
  attemptCount: number;
  retryCount: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError: string | null;
  status: 'pending' | 'retrying' | 'dead_letter';
  createdAt: number;
  updatedAt: number;
}

export interface CryptoKeyRecord {
  id: string;
  purpose: 'obsidian_token_aes_gcm';
  algorithm: 'AES-GCM';
  key: CryptoKey;
  createdAt: number;
}

export interface EncryptedTokenEnvelope {
  id: string;
  ivBase64: string;
  cipherBase64: string;
  updatedAt: number;
}

import { openNexusDb, getRecord, putRecord, getAllRecords, deleteRecord, type StoreName } from '../../core/db/db';
import { EVENT_TYPES, eventBus } from '../../core/eventbus/eventbus';

export interface NexusBridgeConfig {
  baseUrl?: string;
}

export class NexusBridge {
  private baseUrl: string;
  // shared app singleton connection ('nexus-singularity' v4) — never closed by destroy()
  private dbPromise: Promise<IDBDatabase> | null = null;
  private masterKey: CryptoKey | null = null;
  private decryptedTokenCache: string | null = null;
  private reauthRequired: boolean = false;
  private heartbeatTimer: number | null = null;
  // in-flight guard: heartbeat/online/panel flushes must not interleave
  private flushPromise: Promise<void> | null = null;

  private static readonly MASTER_KEY_ID = 'obsidian_aes_gcm_master';
  private static readonly STORAGE_ENVELOPE_KEY = 'obsidian_token_envelope';
  private static readonly STORAGE_REAUTH_KEY = 'obsidian_reauth_required';

  constructor(config: NexusBridgeConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://127.0.0.1:27124';
  }

  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openNexusDb();
    return this.dbPromise;
  }

  public async init(): Promise<void> {
    await this.initCryptoKeyStore();
    this.bindSyncTriggers();
  }

  public get isReauthRequired(): boolean {
    return this.reauthRequired;
  }

  public async setObsidianToken(plainToken: string): Promise<void> {
    if (!this.masterKey) {
      await this.initCryptoKeyStore();
    }
    if (!this.masterKey) {
      throw new Error('CryptoKey initialization failed');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(plainToken);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.masterKey,
      data
    );

    const envelope: EncryptedTokenEnvelope = {
      id: 'token_env_primary',
      ivBase64: this.arrayBufferToBase64(iv.buffer),
      cipherBase64: this.arrayBufferToBase64(ciphertext),
      updatedAt: Date.now()
    };

    localStorage.setItem(NexusBridge.STORAGE_ENVELOPE_KEY, JSON.stringify(envelope));
    localStorage.setItem('obsidian_token_cipher', envelope.cipherBase64);
    localStorage.setItem('obsidian_token_iv', envelope.ivBase64);
    localStorage.removeItem(NexusBridge.STORAGE_REAUTH_KEY);

    this.decryptedTokenCache = plainToken;
    this.reauthRequired = false;
  }

  public async getDecryptedToken(): Promise<string | null> {
    if (this.decryptedTokenCache) {
      return this.decryptedTokenCache;
    }

    const rawEnv = localStorage.getItem(NexusBridge.STORAGE_ENVELOPE_KEY);
    if (!rawEnv) return null;

    try {
      const envelope: EncryptedTokenEnvelope = JSON.parse(rawEnv);
      if (!this.masterKey) {
        await this.initCryptoKeyStore();
      }
      if (!this.masterKey) return null;

      const iv = new Uint8Array(this.base64ToArrayBuffer(envelope.ivBase64));
      const ciphertext = this.base64ToArrayBuffer(envelope.cipherBase64);

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.masterKey,
        ciphertext
      );

      const plain = new TextDecoder().decode(decrypted);
      this.decryptedTokenCache = plain;
      return plain;
    } catch {
      return null;
    }
  }

  public async checkConnection(): Promise<boolean> {
    const token = await this.getDecryptedToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/`, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }

  public async pushMarkdown(path: string, md: string): Promise<boolean> {
    const token = await this.getDecryptedToken();
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const endpoint = `/vault/${encodeURI(cleanPath)}`;

    if (token) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/markdown'
          },
          body: md
        });

        if (response.ok) {
          return true;
        }

        if (response.status === 401) {
          this.setReauthFlag();
        }
      } catch {
        // Fallthrough to enqueue
      }
    }

    await this.enqueueQueueItem({
      noteId: path,
      method: 'PUT',
      endpoint,
      bodyMarkdown: md,
      lastError: token ? 'Network or server error during push' : 'Missing authorization token'
    });

    return false;
  }

  public flushQueue(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushQueueInner().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async flushQueueInner(): Promise<void> {
    if (!navigator.onLine) return;
    const token = await this.getDecryptedToken();
    if (!token) {
      this.setReauthFlag();
      return;
    }

    const items = await this.getPendingQueueItems();
    const now = Date.now();

    for (const item of items) {
      if (item.status === 'dead_letter' || item.nextRetryAt > now) {
        continue;
      }

      try {
        const response = await fetch(`${this.baseUrl}${item.endpoint}`, {
          method: item.method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'text/markdown'
          },
          body: item.bodyMarkdown
        });

        if (response.status === 200 || response.status === 201) {
          await this.deleteQueueItem(item.id);
          continue;
        }

        if (response.status === 401) {
          this.setReauthFlag();
          break;
        }

        await this.handleFailedRetry(item, `HTTP ${response.status}: ${response.statusText}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Network error';
        await this.handleFailedRetry(item, errMsg);
      }
    }
  }

  public destroy(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // do NOT close the shared singleton connection used by the rest of the app
    this.dbPromise = null;
  }

  private async initCryptoKeyStore(): Promise<void> {
    const existingRecord = await this.getIdbRecord<CryptoKeyRecord>(
      'crypto_keystore',
      NexusBridge.MASTER_KEY_ID
    );

    if (existingRecord && existingRecord.key) {
      this.masterKey = existingRecord.key;
      return;
    }

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    const record: CryptoKeyRecord = {
      id: NexusBridge.MASTER_KEY_ID,
      purpose: 'obsidian_token_aes_gcm',
      algorithm: 'AES-GCM',
      key,
      createdAt: Date.now()
    };

    await putRecord(await this.db(), 'crypto_keystore', record);
    this.masterKey = key;
  }

  private async enqueueQueueItem(params: {
    noteId: string;
    method: 'PUT' | 'POST' | 'DELETE';
    endpoint: string;
    bodyMarkdown: string;
    lastError: string;
  }): Promise<void> {
    const payloadHash = await this.computeSha256(params.bodyMarkdown);
    const now = Date.now();
    const item: ObsidianSyncQueueItem = {
      id: `queue_${now}_${Math.random().toString(36).substring(2, 9)}`,
      noteId: params.noteId,
      method: params.method,
      endpoint: params.endpoint,
      bodyMarkdown: params.bodyMarkdown,
      payloadHash,
      attemptCount: 1,
      // STORE_SCHEMAS indexes retryCount — keep both fields in sync for diagnostics
      retryCount: 0,
      maxAttempts: 8,
      nextRetryAt: now + Math.pow(2, 1) * 60 * 1000,
      lastError: params.lastError,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };

    await putRecord(await this.db(), 'obsidian_sync_queue', item);
    eventBus.emit(EVENT_TYPES.syncQueued, { queueItemId: item.id, endpoint: item.endpoint, payload: { method: item.method, bodyMarkdown: item.bodyMarkdown } });
  }

  private async handleFailedRetry(item: ObsidianSyncQueueItem, errorMsg: string): Promise<void> {
    const attempt = item.attemptCount + 1;
    const isDead = attempt >= item.maxAttempts;
    const updated: ObsidianSyncQueueItem = {
      ...item,
      attemptCount: attempt,
      lastError: errorMsg,
      status: isDead ? 'dead_letter' : 'retrying',
      nextRetryAt: Date.now() + Math.pow(2, attempt) * 60 * 1000,
      updatedAt: Date.now()
    };

    await putRecord(await this.db(), 'obsidian_sync_queue', updated);
  }

  private async getPendingQueueItems(): Promise<ObsidianSyncQueueItem[]> {
    const rows = await getAllRecords<ObsidianSyncQueueItem>(await this.db(), 'obsidian_sync_queue');
    return rows.filter((r) => r.status === 'pending' || r.status === 'retrying');
  }

  private async deleteQueueItem(id: string): Promise<void> {
    await deleteRecord(await this.db(), 'obsidian_sync_queue', id);
  }

  private async getIdbRecord<T extends { id: string }>(storeName: StoreName, id: string): Promise<T | null> {
    return (await getRecord<T>(await this.db(), storeName, id)) ?? null;
  }

  private bindSyncTriggers(): void {
    // idempotent: repeated init() must not stack heartbeats/listeners
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    window.addEventListener('online', () => {
      this.flushQueue();
    });

    this.heartbeatTimer = window.setInterval(() => {
      this.flushQueue();
    }, 60000);
  }

  private setReauthFlag(): void {
    this.reauthRequired = true;
    localStorage.setItem(NexusBridge.STORAGE_REAUTH_KEY, 'true');
  }

  private async computeSha256(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
