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

export interface NexusBridgeConfig {
  baseUrl?: string;
}

export class NexusBridge {
  private baseUrl: string;
  private dbName = 'nexus_singularity_db';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;
  private masterKey: CryptoKey | null = null;
  private decryptedTokenCache: string | null = null;
  private reauthRequired: boolean = false;
  private heartbeatTimer: number | null = null;

  private static readonly MASTER_KEY_ID = 'obsidian_aes_gcm_master';
  private static readonly STORAGE_ENVELOPE_KEY = 'obsidian_token_envelope';
  private static readonly STORAGE_REAUTH_KEY = 'obsidian_reauth_required';

  constructor(config: NexusBridgeConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://127.0.0.1:27124';
  }

  public async init(): Promise<void> {
    await this.initIndexedDB();
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

  public async flushQueue(): Promise<void> {
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
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('crypto_keystore')) {
          db.createObjectStore('crypto_keystore', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('obsidian_sync_queue')) {
          db.createObjectStore('obsidian_sync_queue', { keyPath: 'id' });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  }

  private async initCryptoKeyStore(): Promise<void> {
    if (!this.db) await this.initIndexedDB();

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

    await this.putIdbRecord('crypto_keystore', record);
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
      maxAttempts: 8,
      nextRetryAt: now + Math.pow(2, 1) * 60 * 1000,
      lastError: params.lastError,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    };

    await this.putIdbRecord('obsidian_sync_queue', item);
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

    await this.putIdbRecord('obsidian_sync_queue', updated);
  }

  private async getPendingQueueItems(): Promise<ObsidianSyncQueueItem[]> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction('obsidian_sync_queue', 'readonly');
      const store = tx.objectStore('obsidian_sync_queue');
      const req = store.getAll();

      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async deleteQueueItem(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('obsidian_sync_queue', 'readwrite');
      const store = tx.objectStore('obsidian_sync_queue');
      const req = store.delete(id);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async getIdbRecord<T>(storeName: string, id: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  private async putIdbRecord<T>(storeName: string, record: T): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) return reject(new Error('DB not initialized'));
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(record);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private bindSyncTriggers(): void {
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
