/**
 * @module security/secret-patterns
 * @description Deteccion y masking de secretos en valores.
 *
 * Proporciona patrones regex para detectar credenciales comunes
 * y funciones para ofuscarlas antes de persistirlas en historial.
 */

import type { SecretPattern } from './types.js';

/** Patrones por defecto para deteccion de secretos. */
export const DEFAULT_SECRET_PATTERNS: SecretPattern[] = [
  {
    name: 'api-key-generic',
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
    replacement: '[REDACTED:api-key]',
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    name: 'password-field',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{4,})['"]?/gi,
    replacement: '[REDACTED:password]',
  },
  {
    name: 'aws-key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED:aws-key]',
  },
  {
    name: 'jwt',
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    name: 'hex-secret-32plus',
    pattern: /(?:secret|token)\s*[:=]\s*['"]?([0-9a-f]{32,})['"]?/gi,
    replacement: '[REDACTED:secret]',
  },
];

/**
 * Reemplaza secretos detectados con placeholders [REDACTED:tipo].
 * Recorre recursivamente objetos y arrays.
 */
export function maskSecrets(value: any, patterns?: SecretPattern[]): any {
  const activePatterns = patterns ?? DEFAULT_SECRET_PATTERNS;

  if (typeof value === 'string') {
    let masked = value;
    for (const { pattern, replacement } of activePatterns) {
      pattern.lastIndex = 0;
      masked = masked.replace(pattern, replacement);
    }
    return masked;
  }

  if (Array.isArray(value)) {
    return value.map(item => maskSecrets(item, activePatterns));
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = maskSecrets(v, activePatterns);
    }
    return result;
  }

  return value;
}

/**
 * Detecta si un valor contiene patrones de secretos.
 * Retorna true si al menos un patron hace match.
 */
export function containsSecret(value: any, patterns?: SecretPattern[]): boolean {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const activePatterns = patterns ?? DEFAULT_SECRET_PATTERNS;
  for (const { pattern } of activePatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(serialized)) return true;
  }
  return false;
}
