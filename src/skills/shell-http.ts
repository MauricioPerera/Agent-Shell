/**
 * @module skills/shell-http
 * @description HTTP request skills using native fetch().
 */

import { command } from '../command-builder/index.js';
import type { SkillEntry } from './scaffold.js';

async function doFetch(url: string, method: string, body?: any, headers?: Record<string, string>): Promise<any> {
  const opts: RequestInit = { method, headers: headers || {} };
  if (body && method !== 'GET' && method !== 'HEAD') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers?.['content-type'] && !headers?.['Content-Type']) {
      (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(url, opts);
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
