/**
 * Tests for src/cli/index.ts profile validation.
 *
 * Regresion: un valor de --profile/AGENT_SHELL_PROFILE invalido llegaba sin
 * validar a AGENT_PROFILES[profile] dentro de resolveAgentPermissions() y
 * reventaba con un TypeError no controlado ("... is not iterable"). Y no
 * pasar --profile en absoluto (acceso sin restricciones) no tenia ninguna
 * advertencia, a diferencia de la de "sin auth".
 *
 * Solo se testean las funciones puras validateProfile/warnIfUnrestricted
 * (exportadas para esto), no main()/serveStdio()/serveHttp(): esas arrancan
 * un server real (stdin listeners / bind de puerto) y no son unit-testeables
 * sin un harness mas pesado.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateProfile, warnIfUnrestricted } from '../src/cli/index.js';

describe('CLI profile validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CLI01: validateProfile acepta los 4 perfiles conocidos', () => {
    for (const name of ['admin', 'operator', 'reader', 'restricted']) {
      expect(validateProfile(name)).toBe(name);
    }
  });

  it('CLI02: validateProfile retorna undefined si no se paso nada', () => {
    expect(validateProfile(undefined)).toBeUndefined();
  });

  it('CLI03: validateProfile con un valor invalido loguea y termina el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateProfile('bogus')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid profile: 'bogus'"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('admin, operator, reader, restricted'));
  });

  it('CLI04: warnIfUnrestricted avisa cuando no hay profile', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnIfUnrestricted(undefined);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('UNRESTRICTED access'));
  });

  it('CLI05: warnIfUnrestricted no avisa cuando hay un profile', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnIfUnrestricted('restricted' as any);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
