/**
 * @module context-store/encrypted-storage-adapter
 * @description Decorator que encripta/desencripta datos antes de delegar a otro StorageAdapter.
 *
 * Usa AES-256-GCM con IV aleatorio por operacion. Compatible hacia atras:
 * si load() encuentra datos sin flag _encrypted, los retorna sin descifrar.
 */

import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from 'node:crypto';
import type { StorageAdapter, SessionStore } from './types.js';

/** Configuracion de encriptacion. */
export interface EncryptionConfig {
  /** Clave de 32 bytes para AES-256. */
  key: Buffer;
  /** Algoritmo (default: 'aes-256-gcm'). */
  algorithm?: 'aes-256-gcm';
}

/** Payload encriptado almacenado en el adapter subyacente. */
interface EncryptedPayload {
  _encrypted: true;
  iv: string;
  tag: string;
  data: string;
}

export class EncryptedStorageAdapter implements StorageAdapter {
  readonly name: string;
  private readonly inner: StorageAdapter;
  private readonly key: Buffer;
  private readonly algorithm: 'aes-256-gcm';

  constructor(inner: StorageAdapter, config: EncryptionConfig) {
    this.inner = inner;
    this.name = `encrypted(${inner.name})`;
    this.key = config.key;
    this.algorithm = config.algorithm ?? 'aes-256-gcm';

    if (this.key.length !== 32) {
      throw new Error('Encryption key must be exactly 32 bytes for AES-256');
    }
  }

  async initialize(session_id: string): Promise<void> {
    return this.inner.initialize(session_id);
  }

  async load(session_id: string): Promise<SessionStore | null> {
    const raw = await this.inner.load(session_id);
    if (!raw) return null;

    // Backward compat: unencrypted data passes through
    if (!('_encrypted' in (raw as object))) return raw;

    return this.decrypt(raw as unknown as EncryptedPayload);
  }

  async save(session_id: string, store: SessionStore): Promise<void> {
    const encrypted = this.encrypt(store);
    await this.inner.save(session_id, encrypted as unknown as SessionStore);
  }

  async destroy(session_id: string): Promise<void> {
    return this.inner.destroy(session_id);
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async dispose(): Promise<void> {
    return this.inner.dispose();
  }

  private encrypt(data: SessionStore): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv(this.algorithm, this.key, iv) as CipherGCM;
    const plaintext = JSON.stringify(data);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();
    return {
      _encrypted: true,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted,
    };
  }

  private decrypt(payload: EncryptedPayload): SessionStore {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const decipher = createDecipheriv(this.algorithm, this.key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(payload.data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }
}
