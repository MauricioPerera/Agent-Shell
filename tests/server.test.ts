/**
 * Tests for src/server/index.ts's pure exports: maskToken, validatePort,
 * validateConfigFile.
 *
 * Regresion: server/index.ts had ZERO test coverage — main() ran
 * unconditionally at module scope (no isDirectExecution guard like
 * cli/index.ts has), so importing the module for its named exports would
 * also bind a real HTTP listener as a side effect. That's how the stale
 * "Shell skills: 12 commands registered" log (round 11 audit finding) went
 * unnoticed: nothing ever imported this file to check it. Fixed by adding
 * the same isDirectExecution guard cli/index.ts uses.
 *
 * Unlike cli/index.ts's validatePort/validateConfigFile (which fail via
 * console.error + process.exit(1)), server/index.ts's versions throw a
 * plain Error, caught by its own main().catch() convention — so these
 * tests assert on thrown Error messages, not process.exit spies.
 */

import { describe, it, expect } from 'vitest';
import { maskToken, validatePort, validateConfigFile } from '../src/server/index.js';

describe('server maskToken', () => {
  it('SRV01: tokens of 8 chars or fewer are fully masked', () => {
    expect(maskToken('short')).toBe('***');
    expect(maskToken('12345678')).toBe('***');
  });

  it('SRV02: longer tokens reveal a suffix scaled to length, never a prefix', () => {
    const masked = maskToken('abcdefghijkl'); // length 12 -> visibleChars = min(4, 3) = 3
    expect(masked).toBe('*********jkl');
    expect(masked.endsWith('jkl')).toBe(true);
    expect(masked.startsWith('a')).toBe(false);
  });

  it('SRV03: visible suffix is capped at 4 chars even for very long tokens', () => {
    const token = 'a'.repeat(40) + 'WXYZ';
    const masked = maskToken(token);
    expect(masked).toBe('*'.repeat(40) + 'WXYZ');
  });
});

describe('server validatePort', () => {
  it('SRV04: accepts valid ports', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort('0')).toBe(0);
    expect(validatePort('65535')).toBe(65535);
  });

  it('SRV05: rejects non-numeric input', () => {
    expect(() => validatePort('abc')).toThrow("Invalid port: 'abc'");
  });

  it('SRV06: rejects out-of-range ports', () => {
    expect(() => validatePort('70000')).toThrow('Must be an integer between 0 and 65535');
    expect(() => validatePort('-1')).toThrow('Must be an integer between 0 and 65535');
  });
});

describe('server validateConfigFile', () => {
  it('SRV07: accepts a well-typed config as-is', () => {
    const raw = { port: 3000, host: '127.0.0.1', corsOrigin: '*', agentProfile: 'reader', auth: { bearerToken: 'secret' } };
    expect(validateConfigFile(raw, 'x.json')).toEqual(raw);
  });

  it('SRV08: drops a non-numeric port with a warning instead of letting it become NaN', () => {
    const result = validateConfigFile({ port: 'not-a-number' }, 'x.json');
    expect(result.port).toBeUndefined();
  });

  it('SRV09: a mistyped agentProfile fails closed (throws), not silently undefined', () => {
    expect(() => validateConfigFile({ agentProfile: 123 }, 'x.json')).toThrow("field 'agentProfile' should be a string");
  });

  it('SRV10: skills is server-only and passes through when it is an object', () => {
    const result = validateConfigFile({ skills: { cli: false, shell: true } }, 'x.json');
    expect(result.skills).toEqual({ cli: false, shell: true });
  });

  it('SRV11: a non-object skills value is dropped, not thrown', () => {
    const result = validateConfigFile({ skills: 'nope' }, 'x.json');
    expect(result.skills).toBeUndefined();
  });

  /**
   * Regresion (ronda 60 del audit, MEDIUM): mismo hueco que cli/index.ts —
   * ShellAdapterConfig.network/.executionLimits ya existian y
   * createShellAdapter() ya los reenviaba, pero server/index.ts tampoco
   * los poblaba desde ningun lado.
   */
  it('SRV12: accepts justBash.network/executionLimits well-typed as-is', () => {
    const raw = { justBash: { network: { allowedMethods: ['GET'] }, executionLimits: { maxCommandCount: 50 } } };
    expect(validateConfigFile(raw, 'x.json')).toEqual(raw);
  });

  it('SRV13: a mistyped justBash fails closed (throws), not silently "no restriction"', () => {
    expect(() => validateConfigFile({ justBash: { network: { allowedUrlPrefixes: 'not-an-array' } } }, 'x.json'))
      .toThrow("field 'justBash.network.allowedUrlPrefixes' must be an array of strings");
  });
});
