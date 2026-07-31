/**
 * Tests for src/shared/config-validation.ts — the shape-validation logic
 * shared by cli/index.ts and server/index.ts's agent-shell.config.json
 * loaders, extracted after the two entry points' validateConfigFile/
 * validateRbacConfig/validatePort/createAuditLogger drifted into near-
 * duplicate copies with different failure conventions (cli: process.exit,
 * server: throw). This file tests the shared shape logic directly via an
 * injected fail callback that throws a marker string, independent of
 * either entry point's actual exit/throw behavior — that wiring is still
 * covered by tests/cli.test.ts and by live verification against the
 * compiled server binary.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isValidShellAdapter,
  validateRbacConfigShape,
  validatePortShape,
  validateCommonConfigFields,
} from '../src/shared/config-validation.js';

function throwingFail(message: string): never {
  throw new Error(message);
}

describe('shared/config-validation', () => {
  it('SCV01: isValidShellAdapter acepta los 3 valores conocidos y rechaza el resto', () => {
    expect(isValidShellAdapter('native')).toBe(true);
    expect(isValidShellAdapter('just-bash')).toBe(true);
    expect(isValidShellAdapter('auto')).toBe(true);
    expect(isValidShellAdapter('jsut-bash')).toBe(false);
  });

  it('SCV02: validatePortShape acepta puertos validos y rechaza el resto via fail()', () => {
    expect(validatePortShape('3000', throwingFail)).toBe(3000);
    expect(() => validatePortShape('abc', throwingFail)).toThrow("Invalid port: 'abc'");
    expect(() => validatePortShape('70000', throwingFail)).toThrow('Invalid port');
  });

  it('SCV03: validateRbacConfigShape acepta roles+defaultRole bien formados', () => {
    const raw = {
      roles: [
        { name: 'viewer', permissions: ['users:read'] },
        { name: 'editor', permissions: ['users:write'], inherits: ['viewer'] },
      ],
      defaultRole: 'viewer',
    };
    expect(validateRbacConfigShape(raw, 'x.json', throwingFail)).toEqual(raw);
  });

  it('SCV04: validateRbacConfigShape rechaza roles[] ausente', () => {
    expect(() => validateRbacConfigShape({}, 'x.json', throwingFail))
      .toThrow("field 'rbac' must be an object with a 'roles' array");
  });

  it('SCV05: validateCommonConfigFields falla cerrado en agentProfile mal tipado', () => {
    expect(() => validateCommonConfigFields({ agentProfile: 123 }, 'x.json', { fail: throwingFail, warn: () => {} }))
      .toThrow("field 'agentProfile' should be a string");
  });

  it('SCV06: validateCommonConfigFields avisa (no falla) en port mal tipado', () => {
    const warn = vi.fn();
    const result = validateCommonConfigFields({ port: 'not-a-number' }, 'x.json', { fail: throwingFail, warn });
    expect(result.port).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('port', 'an integer');
  });

  it('SCV07: validateCommonConfigFields no incluye skills (campo server-only)', () => {
    const result = validateCommonConfigFields({ skills: { cli: false } }, 'x.json', { fail: throwingFail, warn: () => {} });
    expect(result.skills).toBeUndefined();
  });
});
