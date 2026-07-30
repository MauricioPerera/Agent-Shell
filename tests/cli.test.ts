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
import { validateProfile, warnIfUnrestricted, validateConfigFile } from '../src/cli/index.js';

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

/**
 * Regresion: agent-shell.config.json se usaba sin validar tipo/forma —
 * un port no-numerico llegaba sin avisar a parseInt() y se volvia NaN
 * silenciosamente en vez de fallar con un mensaje claro.
 */
describe('CLI config file validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CLI06: acepta un config bien tipado tal cual', () => {
    const raw = { port: 3000, host: '127.0.0.1', corsOrigin: '*', agentProfile: 'reader', auth: { bearerToken: 'secret' } };
    expect(validateConfigFile(raw, 'x.json')).toEqual(raw);
  });

  it('CLI07: descarta port no-numerico con warning, no lo deja pasar como NaN', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateConfigFile({ port: 'not-a-number' }, 'x.json');
    expect(result.port).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'port' should be an integer"));
  });

  it('CLI08: descarta agentProfile no-string con warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateConfigFile({ agentProfile: 123 }, 'x.json');
    expect(result.agentProfile).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'agentProfile' should be a string"));
  });

  it('CLI09: acepta corsOrigin como array de strings', () => {
    const result = validateConfigFile({ corsOrigin: ['https://a.com', 'https://b.com'] }, 'x.json');
    expect(result.corsOrigin).toEqual(['https://a.com', 'https://b.com']);
  });

  it('CLI10: descarta corsOrigin con elementos no-string', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateConfigFile({ corsOrigin: ['ok', 42] }, 'x.json');
    expect(result.corsOrigin).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'corsOrigin'"));
  });

  it('CLI11: config vacio no genera warnings ni campos', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(validateConfigFile({}, 'x.json')).toEqual({});
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
