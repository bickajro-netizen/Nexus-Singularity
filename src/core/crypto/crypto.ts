// AES-GCM 256 keystore (crypto_keystore store). Keys are non-extractable;
// envelopes carry a fresh 12-byte IV per encryption.

import type { EncryptedTokenEnvelope } from '../types';
import { openNexusDb, getRecord, putRecord, deleteRecord } from '../db/db';

interface KeyRecord { id: string; algorithm: string; created: string; key: CryptoKey }

const PRIMARY_KEY_ID = 'primary';

export class CryptoKeyStore {
  async getKey(id: string): Promise<CryptoKey | undefined> {
    const db = await openNexusDb();
    const rec = await getRecord<KeyRecord>(db, 'crypto_keystore', id);
    return rec?.key;
  }

  async addKey(id: string, key: CryptoKey): Promise<void> {
    const db = await openNexusDb();
    const rec: KeyRecord = { id, algorithm: key.algorithm.name, created: new Date().toISOString(), key };
    await putRecord(db, 'crypto_keystore', rec);
  }

  async removeKey(id: string): Promise<void> {
    const db = await openNexusDb();
    await deleteRecord(db, 'crypto_keystore', id);
  }

  async getOrCreatePrimary(): Promise<CryptoKey> {
    const existing = await this.getKey(PRIMARY_KEY_ID);
    if (existing) return existing;
    const key = await generateAesKey();
    await this.addKey(PRIMARY_KEY_ID, key);
    return key;
  }
}

export async function generateAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptEnvelope(key: CryptoKey, plaintext: string): Promise<EncryptedTokenEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { iv, ciphertext };
}

export async function decryptEnvelope(key: CryptoKey, envelope: EncryptedTokenEnvelope): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.iv }, key, envelope.ciphertext);
  return new TextDecoder().decode(plain);
}

export const cryptoKeyStore = new CryptoKeyStore();
