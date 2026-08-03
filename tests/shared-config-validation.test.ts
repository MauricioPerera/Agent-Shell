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
  validateJustBashConfigShape,
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

  /**
   * Regresion (ronda 60 del audit, MEDIUM): `justBash.network`/
   * `.executionLimits` existian en just-bash/types.ts y ya se reenviaban
   * si estaban presentes, pero ningun entry point los poblaba desde
   * ningun lado — este bloque cubre el validador que ahora los expone
   * via agent-shell.config.json.
   */
  describe('validateJustBashConfigShape', () => {
    it('SCV08: acepta network + executionLimits bien formados', () => {
      const raw = {
        network: { allowedUrlPrefixes: ['https://api.example.com/'], allowedMethods: ['GET', 'POST'] },
        executionLimits: { maxCommandCount: 100, maxLoopIterations: 1000, maxCallDepth: 10 },
      };
      expect(validateJustBashConfigShape(raw, 'x.json', throwingFail)).toEqual(raw);
    });

    it('SCV09: acepta un objeto vacio (ambos campos opcionales)', () => {
      expect(validateJustBashConfigShape({}, 'x.json', throwingFail)).toEqual({});
    });

    it('SCV10: rechaza justBash que no sea un objeto', () => {
      expect(() => validateJustBashConfigShape('nope', 'x.json', throwingFail))
        .toThrow("field 'justBash' must be an object");
      expect(() => validateJustBashConfigShape(['nope'], 'x.json', throwingFail))
        .toThrow("field 'justBash' must be an object");
    });

    it('SCV11: rechaza network.allowedUrlPrefixes que no sea array de strings', () => {
      expect(() => validateJustBashConfigShape({ network: { allowedUrlPrefixes: 'not-an-array' } }, 'x.json', throwingFail))
        .toThrow("field 'justBash.network.allowedUrlPrefixes' must be an array of strings");
      expect(() => validateJustBashConfigShape({ network: { allowedUrlPrefixes: [123] } }, 'x.json', throwingFail))
        .toThrow("field 'justBash.network.allowedUrlPrefixes' must be an array of strings");
    });

    it('SCV12: rechaza executionLimits con un valor no-entero-positivo', () => {
      expect(() => validateJustBashConfigShape({ executionLimits: { maxLoopIterations: -5 } }, 'x.json', throwingFail))
        .toThrow("field 'justBash.executionLimits.maxLoopIterations' must be a positive integer");
      expect(() => validateJustBashConfigShape({ executionLimits: { maxCallDepth: 1.5 } }, 'x.json', throwingFail))
        .toThrow("field 'justBash.executionLimits.maxCallDepth' must be a positive integer");
      expect(() => validateJustBashConfigShape({ executionLimits: { maxCommandCount: 'ten' } }, 'x.json', throwingFail))
        .toThrow("field 'justBash.executionLimits.maxCommandCount' must be a positive integer");
    });

    it('SCV13: validateCommonConfigFields expone justBash falleando cerrado (no warn-and-drop)', () => {
      expect(() => validateCommonConfigFields({ justBash: { executionLimits: { maxCallDepth: -1 } } }, 'x.json', { fail: throwingFail, warn: () => {} }))
        .toThrow("field 'justBash.executionLimits.maxCallDepth' must be a positive integer");

      const ok = validateCommonConfigFields(
        { justBash: { network: { allowedMethods: ['GET'] } } },
        'x.json',
        { fail: throwingFail, warn: () => {} }
      );
      expect(ok.justBash).toEqual({ network: { allowedMethods: ['GET'] } });
    });
  });
});
