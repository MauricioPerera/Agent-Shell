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
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-+/=]{20,})['"]?/gi,
    replacement: '[REDACTED:api-key]',
  },
  {
    name: 'bearer-token',
    pattern: /Bearer\s+[a-zA-Z0-9_\-.+/=]{20,}/gi,
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
    // Regresion (ronda 61 del audit — hallada por un pase de QA
    // independiente vía pool exec, sin contexto de rondas previas,
    // CRITICAL): el grupo `(?:[\s\S]+?-----END...KEY-----)?` era
    // OPCIONAL — si no aparecia un END que matcheara (mismatched,
    // truncado, o ausente), el regex igual "tenia exito" matcheando
    // SOLO la linea BEGIN, dejando el BODY de la clave (la parte
    // sensible) sin redactar en absoluto. Un bloque PEM deliberadamente
    // mal formado (exactamente lo que un atacante craftea para evadir
    // un redactor ingenuo) bypaseaba maskSecrets() por completo para el
    // body. Ahora la alternancia intenta primero un END real (no-greedy,
    // preserva contenido no relacionado que venga despues cuando el END
    // SI aparece), y si eso nunca matchea en el resto del string, cae a
    // consumir todo lo que resta (`[\s\S]*`) — preferir sobre-redactar
    // a filtrar el secreto.
    name: 'private-key',
    pattern: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)?\s*PRIVATE\s+KEY-----(?:[\s\S]+?-----END\s+(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)?\s*PRIVATE\s+KEY-----|[\s\S]*)/g,
    replacement: '[REDACTED:private-key]',
  },
  {
    name: 'hex-secret-32plus',
    pattern: /(?:secret|token)\s*[:=]\s*['"]?([0-9a-f]{32,})['"]?/gi,
    replacement: '[REDACTED:secret]',
  },
  {
    // Credentials embedded in a connection URL: postgres://user:pass@host,
    // https://<key>@o123.ingest.sentry.io/... (Sentry DSN), redis://:pass@host,
    // amqp://user:pass@host. Catches values whose secret isn't behind a
    // `key=value`-shaped prefix like the patterns above expect.
    //
    // Regresion (ronda 67 del audit, CRITICAL): [a-z0-9+.-]* (resto del
    // esquema) y [^/\s@]+ (parte credential antes de @) eran greedy sin
    // cota, cada uno seguido de un literal obligatorio ("://" y "@") que
    // puede no aparecer nunca en el input. Con el flag /g, el motor
    // reintenta el regex completo desde CADA posicion del string — en
    // cualquier posicion dentro de un tramo largo sin "://" ni "@" (ej.
    // una URL de 40KB sin credenciales embebidas), el backtracking de
    // [a-z0-9+.-]* buscando "://" cuesta O(resto-del-string) POR posicion,
    // sumando O(n^2) total (~600ms a 40KB, sin limite superior probado —
    // >120s a 1MB). Bloquea el event loop sincronicamente, inmune al
    // timeout de Core/Executor (Promise.race no puede interrumpir un
    // regex.replace() en curso). Alcanzable via cualquier argumento en el
    // path validate/dry-run/confirm, o cualquier env var con forma de URL
    // larga (filterSensitiveEnv corre esto en CADA shell:exec/git/spawn).
    // Acotar ambos cuantificadores greedy a un maximo razonable (esquemas
    // reales tienen <20 chars; un user:pass realista cabe en 512) limita
    // el backtracking a O(cota) por posicion en vez de O(n), volviendo el
    // costo total lineal sin importar el largo del input.
    name: 'url-credentials',
    pattern: /[a-z][a-z0-9+.-]{0,20}:\/\/[^/\s@]{1,512}@[^\s'"]+/gi,
    replacement: '[REDACTED:url-credentials]',
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

/** Patrones de nombre de variable de entorno que se consideran sensibles. */
export const SENSITIVE_ENV_KEY_PATTERNS: RegExp[] = [
  /password/i, /secret/i, /token/i, /key/i, /auth/i,
  /credential/i, /private/i, /api_key/i, /apikey/i,
];

/** True si el nombre de una env var matchea algun patron sensible. */
export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_ENV_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Filtra un objeto de variables de entorno, quitando las que matchean un
 * nombre sensible O cuyo VALOR contiene un secreto (misma logica de dos
 * capas que env:get/env:list en shell-env.ts — un nombre "inocente" como
 * DATABASE_URL o SENTRY_DSN puede llevar una credencial embebida en el
 * valor). Usado para no heredar credenciales del proceso host hacia un
 * child process que un agente puede invocar (shell:exec).
 */
export function filterSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSensitiveEnvKey(key) || containsSecret(value)) continue;
    filtered[key] = value;
  }
  return filtered;
}
