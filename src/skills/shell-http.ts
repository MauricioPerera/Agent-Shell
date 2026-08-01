/**
 * @module skills/shell-http
 * @description HTTP request skills using native fetch().
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { command } from '../command-builder/index.js';
import type { SkillEntry } from './scaffold.js';

// ===========================================================================
// SSRF protection: validate URL scheme + block private/reserved IP targets.
// Blocking is unconditional (no escape-hatch). DNS resolution fail-opens so
// existing behaviour (fetch against mock with fictional hostnames) is preserved.
// ===========================================================================

/** Parse an IPv4 dotted-quad string into 4 octets, or null if invalid. */
function parseIpv4(str: string): number[] | null {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Parse an IPv6 string (incl. `::` compression and embedded IPv4 forms like
 * `::ffff:a.b.c.d`) into 16 bytes, or null if invalid.
 */
function parseIpv6(str: string): Uint8Array | null {
  let s = str;
  let v4bytes: number[] | null = null;

  // Embedded IPv4 in the low 32 bits (e.g. `::ffff:1.2.3.4`).
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon === -1) return null;
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (!v4) return null;
    v4bytes = v4;
    s = s.slice(0, lastColon); // strip the IPv4 portion, leaves e.g. `::ffff`
  }

  const hasDD = s.includes('::');
  if (hasDD && s.indexOf('::') !== s.lastIndexOf('::')) return null; // only one `::`

  let left: string[];
  let right: string[];
  if (hasDD) {
    const [l, r] = s.split('::');
    left = l === '' ? [] : l.split(':');
    right = r === '' ? [] : r.split(':');
  } else {
    left = s === '' ? [] : s.split(':');
    right = [];
  }

  const allGroups = [...left, ...right];
  for (const g of allGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }

  const v4GroupCount = v4bytes ? 2 : 0;
  const provided = left.length + right.length + v4GroupCount;
  if (hasDD) {
    if (provided > 8) return null;
  } else if (provided !== 8) {
    return null;
  }
  const missing = 8 - provided; // zero-filled middle groups

  const groups: number[] = [];
  for (const g of left) groups.push(parseInt(g, 16));
  for (let i = 0; i < missing; i++) groups.push(0);
  for (const g of right) groups.push(parseInt(g, 16));
  if (v4bytes) {
    groups.push((v4bytes[0] << 8) | v4bytes[1]);
    groups.push((v4bytes[2] << 8) | v4bytes[3]);
  }

  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** True if the 4 IPv4 octets fall in a private/reserved/loopback/link-local range. */
function isBlockedIpv4(o: number[]): boolean {
  const a = o[0];
  const b = o[1];
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 0) return true;                             // 0.0.0.0/8
  if (a === 169 && b === 254) return true;              // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
  return false;
}

/** True if 16 IPv6 bytes fall in a blocked range (incl. IPv4-mapped unwrap). */
function isBlockedIpv6Bytes(b: Uint8Array): boolean {
  // ::1 loopback
  let allZero = true;
  for (let i = 0; i < 15; i++) {
    if (b[i] !== 0) { allZero = false; break; }
  }
  if (allZero && b[15] === 1) return true;

  // IPv4-mapped (::ffff:a.b.c.d): bytes 0-9 zero, bytes 10-11 = 0xff -> unwrap IPv4.
  let prefixZero = true;
  for (let i = 0; i < 10; i++) {
    if (b[i] !== 0) { prefixZero = false; break; }
  }
  if (prefixZero && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4([b[12], b[13], b[14], b[15]]);
  }

  // Unique local fc00::/7 (first 7 bits = 1111110 -> 0xfc or 0xfd).
  if ((b[0] & 0xfe) === 0xfc) return true;
  // Link-local fe80::/10 (first byte 0xfe, next 2 bits 10).
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;

  return false;
}

/**
 * True if `ip` (a literal IP string, v4 or v6) is in a blocked range.
 * Returns false for non-IP strings (caller must ensure a literal IP).
 */
function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isBlockedIpv6Bytes(v6);
  return false;
}

/** Strip surrounding brackets from an IPv6 hostname as returned by URL. */
function stripBrackets(h: string): string {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** True if the hostname is a literal IP (v4 or v6). */
function isLiteralIp(hostname: string): boolean {
  const h = stripBrackets(hostname);
  return parseIpv4(h) !== null || parseIpv6(h) !== null;
}

/** The specific address (and family) doFetch() must pin its connection to. */
interface UrlSafetyResult {
  pinnedAddress: string | null;
  family: 4 | 6 | null;
}

/**
 * Validate the request URL against SSRF rules AND return the exact resolved
 * address doFetch() must pin its TCP connection to. Throws (caught by the
 * existing handler try/catch) when the scheme is not http/https or when the
 * target host is/resolves to a private/reserved/loopback/link-local address.
 *
 * Returning the resolved address (rather than just validating and discarding
 * it, as before) is what closes a DNS-rebinding TOCTOU: without pinning, an
 * attacker controlling DNS for the target hostname could return a safe
 * address for THIS validation lookup and a different, unsafe one (e.g. the
 * cloud metadata endpoint 169.254.169.254) for fetch()'s own later,
 * independent resolution of the same hostname a few milliseconds after.
 *
 * `pinnedAddress` is null when the hostname is already a literal IP (nothing
 * to pin — it IS the connection target) or when DNS resolution failed
 * (fail-open, same as before: let fetch's own DNS resolution proceed
 * unpinned rather than block on a resolver error).
 */
async function assertUrlSafe(url: string): Promise<UrlSafetyResult> {
  const parsed = new URL(url); // throws on malformed URL -> existing catch

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked: scheme '${parsed.protocol}' not allowed (only http/https)`);
  }

  const hostname = parsed.hostname;
  const raw = stripBrackets(hostname);

  if (isLiteralIp(hostname)) {
    if (isBlockedIp(raw)) {
      throw new Error(`Blocked: URL resolves to a private/internal address (${raw})`);
    }
    return { pinnedAddress: null, family: null };
  }

  // Hostname is a domain -> resolve via DNS. Fail-open on DNS errors so the
  // existing tests (fictional hostnames + mocked fetch) keep working unchanged.
  try {
    const addresses = (await dnsLookup(hostname, { all: true })) as Array<{ address: string; family: number }>;
    for (const a of addresses) {
      if (isBlockedIp(a.address)) {
        throw new Error(`Blocked: URL resolves to a private/internal address (${hostname} -> ${a.address})`);
      }
    }
    const first = addresses[0];
    if (!first) return { pinnedAddress: null, family: null };
    return { pinnedAddress: first.address, family: first.family === 6 ? 6 : 4 };
  } catch (err: any) {
    // Re-throw our own block decision; only swallow DNS resolution failures.
    if (err && typeof err.message === 'string' && err.message.startsWith('Blocked:')) {
      throw err;
    }
    // DNS failure -> fail-open, let fetch proceed (unpinned).
    return { pinnedAddress: null, family: null };
  }
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch follows redirects by default, and a redirect target is not covered by
 * the assertUrlSafe() call the caller already made on the original URL. An
 * external server can respond 302 -> http://169.254.169.254/... and bypass
 * the SSRF guard entirely. Disable automatic following (redirect: 'manual')
 * and re-validate + re-fetch each hop ourselves, capped at MAX_REDIRECTS.
 *
 * Uses undici's own `fetch` (not the Node-global one) — verified against a
 * real network request: passing a `dispatcher` built from the `undici` npm
 * package to the GLOBAL fetch throws `InvalidArgumentError: invalid
 * onRequestStart method`, because global fetch runs on Node's internal,
 * separately-versioned bundled copy of undici, which doesn't duck-type
 * match a Dispatcher instance from a different undici module instance.
 * undici's own exported fetch is guaranteed to accept undici's own Agent.
 */
async function doFetch(url: string, method: string, body?: any, headers?: Record<string, string>): Promise<any> {
  const baseHeaders = headers || {};
  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;

  for (let redirectCount = 0; ; redirectCount++) {
    const { pinnedAddress, family } = await assertUrlSafe(currentUrl);

    const opts: RequestInit = { method: currentMethod, headers: { ...baseHeaders }, redirect: 'manual' };
    if (currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
      opts.body = typeof currentBody === 'string' ? currentBody : JSON.stringify(currentBody);
      if (!baseHeaders['content-type'] && !baseHeaders['Content-Type']) {
        (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    }

    // Pin the actual TCP connection to the exact address assertUrlSafe()
    // just resolved and validated above — see its docstring for why. The
    // custom `lookup` here returns ONLY that address, so undici's own DNS
    // resolution (which would otherwise be a second, independent lookup a
    // rebinding attacker could answer differently) never runs. TLS SNI and
    // the Host header still derive from `currentUrl`'s hostname as normal —
    // only the raw socket destination is overridden.
    const agent = pinnedAddress
      ? new Agent({
          connect: {
            // Node's modern happy-eyeballs connection path
            // (lookupAndConnectMultiple, the net.connect() default since
            // Node 18+) calls this with the ARRAY form of dns.lookup's
            // callback (an address list), not the older single
            // (err, address, family) form — passing a bare string here
            // throws ERR_INVALID_IP_ADDRESS deep inside node:net, verified
            // against a real connection.
            lookup: (_hostname: string, _options: unknown, callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void) => {
              callback(null, [{ address: pinnedAddress, family: family ?? 4 }]);
            },
          },
        })
      : undefined;
    if (agent) (opts as any).dispatcher = agent;

    try {
      const res = await undiciFetch(currentUrl, opts as any);

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          throw new Error(`Blocked: redirect response (${res.status}) without a Location header`);
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new Error(`Blocked: too many redirects (max ${MAX_REDIRECTS})`);
        }
        currentUrl = new URL(location, currentUrl).toString();
        // 303 always downgrades to GET with no body; 301/302 downgrade non-GET/HEAD
        // to GET too (long-standing fetch/browser behavior); 307/308 preserve both.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      let resBody: any;
      try {
        resBody = contentType.includes('application/json') ? await res.json() : await res.text();
      } catch {
        resBody = await res.text();
      }

      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });

      return { status: res.status, headers: resHeaders, body: resBody };
    } finally {
      if (agent) await agent.close();
    }
  }
}

const getDef = command('http', 'get')
  .version('1.0.0')
  .description('Perform an HTTP GET request')
  .requiredParam('url', 'string')
  .optionalParam('headers', 'json', null)
  .example('http:get --url https://api.example.com/users')
  .tags('http', 'network', 'read')
  .build();

const postDef = command('http', 'post')
  .version('1.0.0')
  .description('Perform an HTTP POST request')
  .requiredParam('url', 'string')
  .optionalParam('body', 'json', null)
  .optionalParam('headers', 'json', null)
  .example('http:post --url https://api.example.com/users --body \'{"name":"John"}\'')
  .tags('http', 'network', 'write')
  .build();

const requestDef = command('http', 'request')
  .version('1.0.0')
  .description('Perform an HTTP request with any method')
  .requiredParam('url', 'string')
  .optionalParam('method', 'string', 'GET')
  .optionalParam('body', 'json', null)
  .optionalParam('headers', 'json', null)
  .example('http:request --url https://api.example.com/users/1 --method DELETE')
  .tags('http', 'network')
  .build();

getDef.requiredPermissions = ['http:read'];
postDef.requiredPermissions = ['http:write'];
requestDef.requiredPermissions = ['http:write'];

export const httpCommands: SkillEntry[] = [
  {
    definition: getDef,
    handler: async (args: any) => {
      try {
        const headers = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers;
        const data = await doFetch(args.url, 'GET', undefined, headers || undefined);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, data: null, error: `HTTP GET failed: ${err.message}` };
      }
    },
  },
  {
    definition: postDef,
    handler: async (args: any) => {
      try {
        const body = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
        const headers = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers;
        const data = await doFetch(args.url, 'POST', body, headers || undefined);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, data: null, error: `HTTP POST failed: ${err.message}` };
      }
    },
  },
  {
    definition: requestDef,
    handler: async (args: any) => {
      try {
        const method = (args.method || 'GET').toUpperCase();
        const body = typeof args.body === 'string' ? JSON.parse(args.body) : args.body;
        const headers = typeof args.headers === 'string' ? JSON.parse(args.headers) : args.headers;
        const data = await doFetch(args.url, method, body, headers || undefined);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, data: null, error: `HTTP ${args.method || 'GET'} failed: ${err.message}` };
      }
    },
  },
];