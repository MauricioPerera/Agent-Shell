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
import { validateProfile, warnIfUnrestricted, validateConfigFile, validatePort, validateShellAdapter } from '../src/cli/index.js';

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
 * Regresion: un --shell-adapter/AGENT_SHELL_ADAPTER/config con un typo (ej.
 * 'jsut-bash') caia sin avisar en la rama 'auto' de createShellAdapter() —
 * exactamente el modo de falla "typo debilita en silencio la postura de
 * seguridad" que validateProfile/validatePort ya evitan en este mismo
 * archivo, pero shellAdapter no lo tenia.
 */
describe('CLI shell adapter validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CLI22: validateShellAdapter acepta los 3 valores conocidos', () => {
    for (const name of ['native', 'just-bash', 'auto']) {
      expect(validateShellAdapter(name)).toBe(name);
    }
  });

  it('CLI23: validateShellAdapter retorna undefined si no se paso nada', () => {
    expect(validateShellAdapter(undefined)).toBeUndefined();
  });

  it('CLI24: validateShellAdapter con un valor invalido loguea y termina el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateShellAdapter('jsut-bash')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid shell adapter: 'jsut-bash'"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('native, just-bash, auto'));
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

  /**
   * Regresion: un agentProfile mal tipado (ej. un array o un numero) se
   * descartaba con solo un warning, y config.agentProfile quedaba undefined
   * — que loadConfig()/serveStdio() interpretan como "sin perfil = acceso
   * SIN RESTRICCIONES". Un campo de control de acceso mal tipado debe
   * fallar cerrado (exit 1), no caer al default mas permisivo.
   */
  it('CLI08: agentProfile no-string aborta el proceso (exit 1), no cae a undefined', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ agentProfile: 123 }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
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

  it('CLI12: acepta jailRoot como string', () => {
    const result = validateConfigFile({ jailRoot: '/opt/workspace' }, 'x.json');
    expect(result.jailRoot).toBe('/opt/workspace');
  });

  /**
   * Regresion: mismo patron que CLI08 — jailRoot es tan de control de acceso
   * como agentProfile (determina que puede tocar file:, git: y workspace:),
   * asi que un valor mal tipado debe abortar el proceso, no caer en
   * silencio a "sin jail configurado" (el default MAS permisivo).
   */
  it('CLI13: jailRoot no-string aborta el proceso (exit 1), no cae a "sin jail"', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ jailRoot: 123 }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'jailRoot' should be a string"));
  });

  /**
   * Regresion: server/index.ts ya soportaba shellAdapter (--shell-adapter/
   * AGENT_SHELL_ADAPTER/config), pero cli/index.ts llamaba createShellAdapter()
   * sin argumentos — no habia forma de forzar native (bypasear el sandbox) o
   * just-bash (exigirlo) desde el CLI real.
   */
  it('CLI14: acepta shellAdapter como string', () => {
    const result = validateConfigFile({ shellAdapter: 'just-bash' }, 'x.json');
    expect(result.shellAdapter).toBe('just-bash');
  });

  it('CLI15: descarta shellAdapter no-string con warning', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = validateConfigFile({ shellAdapter: 42 }, 'x.json');
    expect(result.shellAdapter).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'shellAdapter' should be a string"));
  });

  /**
   * Regresion (ronda 60 del audit, MEDIUM): `ShellAdapterConfig.network`/
   * `.executionLimits` (network allowlist y caps de loop/call/comando del
   * sandbox just-bash) ya existian y createShellAdapter() ya los
   * reenviaba si estaban presentes, pero NINGUN entry point real los
   * poblaba desde ningun lado — cero forma de configurarlos en un deploy
   * real via cli/index.ts.
   */
  it('CLI15b: acepta justBash.network/executionLimits bien formados', () => {
    const raw = {
      justBash: {
        network: { allowedUrlPrefixes: ['https://api.example.com/'] },
        executionLimits: { maxLoopIterations: 500 },
      },
    };
    expect(validateConfigFile(raw, 'x.json')).toEqual(raw);
  });

  it('CLI15c: justBash mal tipado aborta el proceso (exit 1), no cae a "sin restriccion"', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ justBash: { executionLimits: { maxCallDepth: -1 } } }, 'x.json'))
      .toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'justBash.executionLimits.maxCallDepth' must be a positive integer"));
  });

  /**
   * Regresion: cli/index.ts no tenia NINGUN soporte de permissions/rbac —
   * RBAC estaba totalmente implementado (src/security/rbac.ts) pero sin
   * superficie de config en ningun entry point real, era inalcanzable.
   * Mismo patron fail-closed que agentProfile/jailRoot: un valor mal
   * tipado aborta el proceso, no cae al default mas permisivo.
   */
  it('CLI16: acepta permissions como array de strings', () => {
    const result = validateConfigFile({ permissions: ['users:read', 'users:write'] }, 'x.json');
    expect(result.permissions).toEqual(['users:read', 'users:write']);
  });

  it('CLI17: permissions no-array-de-strings aborta el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ permissions: ['ok', 42] }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'permissions' should be an array of strings"));
  });

  it('CLI18: acepta un rbac bien formado (roles + defaultRole)', () => {
    const raw = {
      rbac: {
        roles: [
          { name: 'viewer', permissions: ['users:read'] },
          { name: 'editor', permissions: ['users:write'], inherits: ['viewer'] },
        ],
        defaultRole: 'viewer',
      },
    };
    const result = validateConfigFile(raw, 'x.json');
    expect(result.rbac).toEqual(raw.rbac);
  });

  it('CLI19: rbac sin roles[] aborta el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ rbac: { defaultRole: 'viewer' } }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("field 'rbac' must be an object with a 'roles' array"));
  });

  it('CLI20: rbac con un role sin name/permissions valido aborta el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ rbac: { roles: [{ name: 'viewer' }] } }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'permissions' must be an array of strings"));
  });

  it('CLI21: rbac con inherits no-array-de-strings aborta el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({ rbac: { roles: [{ name: 'editor', permissions: [], inherits: [42] }] } }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("'inherits' must be an array of strings"));
  });

  /**
   * Regresion (ronda 24 del audit): RBAC's Map-keyed-by-name constructor
   * silently keeps solo la ULTIMA definicion de un nombre de rol repetido
   * (roles.set() posterior pisa la anterior) — un config con el mismo
   * nombre de rol dos veces (typo/copy-paste plausible en JSON a mano)
   * terminaba con los permisos de la segunda definicion, sin ningun error
   * que apunte al problema.
   */
  it('CLI25: rbac con un nombre de rol duplicado aborta el proceso (exit 1)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validateConfigFile({
      rbac: { roles: [
        { name: 'viewer', permissions: ['users:read'] },
        { name: 'viewer', permissions: ['users:*'] },
      ] },
    }, 'x.json')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("is a duplicate role name"));
  });
});

/**
 * Regresion: un --port/AGENT_SHELL_PORT no numerico llegaba sin validar a
 * parseInt(), se volvia NaN, y solo se notaba despues como el error crudo
 * de Node "options.port should be >= 0 and < 65536" en vez de un mensaje claro.
 */
describe('CLI port validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CLI12: validatePort acepta puertos validos', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort('0')).toBe(0);
    expect(validatePort('65535')).toBe(65535);
  });

  it('CLI13: validatePort con un valor no numerico loguea y termina el proceso', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);

    expect(() => validatePort('abc')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid port: 'abc'"));
  });

  it('CLI14: validatePort rechaza puertos fuera de rango', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validatePort('70000')).toThrow('__process_exit_1__');
    expect(() => validatePort('-1')).toThrow('__process_exit_1__');
    expect(exitSpy).toHaveBeenCalledTimes(2);
  });
});
