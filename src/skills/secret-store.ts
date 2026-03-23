/**
 * @module skills/secret-store
 * @description In-memory encrypted secret storage.
 * Values are AES-256 encrypted at rest and never appear in logs or history.
 */

import { command } from '../command-builder/index.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SkillEntry } from './scaffold.js';

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

export class SecretStore {
  private secrets: Map<string, { iv: string; encrypted: string }> = new Map();
  private readonly key: Buffer;

  constructor(encryptionKey?: string) {
    // Use provided key or generate random one (session-scoped)
    this.key = encryptionKey
      ? Buffer.from(encryptionKey.padEnd(32, '0').slice(0, 32), 'utf-8')
      : randomBytes(32);
  }

  set(name: string, value: string): void {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', this.key, iv);
    let encrypted = cipher.update(value, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    this.secrets.set(name, { iv: iv.toString('hex'), encrypted });
  }

  get(name: string): string | null {
    const entry = this.secrets.get(name);
    if (!entry) return null;
    const decipher = createDecipheriv('aes-256-cbc', this.key, Buffer.from(entry.iv, 'hex'));
    let decrypted = decipher.update(entry.encrypted, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  }

  has(name: string): boolean {
    return this.secrets.has(name);
  }

  delete(name: string): boolean {
    return this.secrets.delete(name);
  }

  list(): string[] {
    return Array.from(this.secrets.keys());
  }

  get size(): number {
    return this.secrets.size;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const setDef = command('secret', 'set').version('1.0.0')
  .description('Store an encrypted secret')
  .requiredParam('name', 'string').requiredParam('value', 'string')
  .example('secret:set --name DB_PASSWORD --value mysecret123')
  .tags('secret', 'write', 'security').build();

const getDef = command('secret', 'get').version('1.0.0')
  .description('Retrieve a secret value')
  .requiredParam('name', 'string')
  .example('secret:get --name DB_PASSWORD')
  .tags('secret', 'read', 'security').build();

const listDef = command('secret', 'list').version('1.0.0')
  .description('List secret names (values are never shown)')
  .example('secret:list')
  .tags('secret', 'read', 'security').build();

const deleteDef = command('secret', 'delete').version('1.0.0')
  .description('Delete a stored secret')
  .requiredParam('name', 'string')
  .example('secret:delete --name DB_PASSWORD')
  .tags('secret', 'write', 'security').build();

setDef.requiredPermissions = ['secret:write'];
getDef.requiredPermissions = ['secret:read'];
listDef.requiredPermissions = ['secret:read'];
deleteDef.requiredPermissions = ['secret:write'];

export function createSecretCommands(store?: SecretStore): SkillEntry[] {
  const secrets = store || new SecretStore();

  return [
    { definition: setDef, handler: async (args: any) => {
      secrets.set(args.name, args.value);
      return { success: true, data: { name: args.name, stored: true, totalSecrets: secrets.size } };
    }},
    { definition: getDef, handler: async (args: any) => {
      const value = secrets.get(args.name);
      if (value === null) return { success: false, data: null, error: `Secret '${args.name}' not found` };
      return { success: true, data: { name: args.name, value } };
    }},
    { definition: listDef, handler: async () => {
      const names = secrets.list();
      return { success: true, data: { names, count: names.length } };
    }},
    { definition: deleteDef, handler: async (args: any) => {
      const deleted = secrets.delete(args.name);
      return deleted
        ? { success: true, data: { name: args.name, deleted: true } }
        : { success: false, data: null, error: `Secret '${args.name}' not found` };
    }},
  ];
}

export const secretCommands: SkillEntry[] = createSecretCommands();
