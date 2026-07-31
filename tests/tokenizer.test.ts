/**
 * Tests para el tokenizador de bajo nivel (src/parser/tokenizer.ts).
 *
 * Cubre: tokenizacion basica, comillas simples/dobles, comillas escapadas
 * (`\"`/`\'`), preservacion de backslashes comunes (rutas de Windows/UNC),
 * quoteArg() como forma segura de embeber valores arbitrarios, y consistencia
 * entre el tokenizador y los segmentadores de nivel superior (pipeline/batch/
 * jq en parser/index.ts) frente a comillas escapadas.
 *
 * Regresion (auditoria "tokenizer quote-rebalancing"): antes de este cambio
 * no existia forma de incluir una comilla literal dentro de un valor entre
 * comillas — una comilla sin escapar en el VALOR terminaba el token ahi
 * mismo, y el resto del input se re-tokenizaba como flags/argumentos
 * nuevos. Ver quoteArg() para la forma segura de embeber un valor arbitrario
 * (p.ej. contenido no confiable) como un unico argumento opaco.
 */

import { describe, it, expect } from 'vitest';
import { tokenize, quoteArg } from '../src/parser/tokenizer.js';
import { parse } from '../src/parser/index.js';

describe('tokenize()', () => {
  it('T01: tokeniza flags y valores sin comillas', () => {
    const tokens = tokenize('--name John --age 30');
    expect(Array.isArray(tokens)).toBe(true);
    const t = tokens as any[];
    expect(t.map(x => x.value)).toEqual(['--name', 'John', '--age', '30']);
    expect(t.every(x => x.quoted === false)).toBe(true);
  });

  it('T02: preserva espacios dentro de comillas', () => {
    const tokens = tokenize('--name "John Doe"') as any[];
    expect(tokens[1].value).toBe('John Doe');
    expect(tokens[1].quoted).toBe(true);
  });

  it('T03: soporta comillas simples igual que dobles', () => {
    const tokens = tokenize("--name 'John Doe'") as any[];
    expect(tokens[1].value).toBe('John Doe');
    expect(tokens[1].quoted).toBe(true);
  });

  it('T04: comilla sin cerrar retorna ParseError, no lanza excepcion', () => {
    const result = tokenize('--name "John') as any;
    expect(Array.isArray(result)).toBe(false);
    expect(result.errorType).toBeDefined();
  });

  it('T05: espacios multiples entre tokens se colapsan', () => {
    const tokens = tokenize('--name    John') as any[];
    expect(tokens.map(t => t.value)).toEqual(['--name', 'John']);
  });

  describe('Comillas escapadas (\\" y \\\')', () => {
    it('T06: \\" dentro de comillas dobles es una comilla literal, no cierra el string', () => {
      const raw = '--note "she said \\"hi\\""';
      const tokens = tokenize(raw) as any[];
      expect(tokens).toHaveLength(2);
      expect(tokens[1].value).toBe('she said "hi"');
      expect(tokens[1].quoted).toBe(true);
    });

    it("T07: \\' dentro de comillas simples es una comilla literal, no cierra el string", () => {
      const raw = "--note 'it\\'s here'";
      const tokens = tokenize(raw) as any[];
      expect(tokens).toHaveLength(2);
      expect(tokens[1].value).toBe("it's here");
    });

    it('T08: comilla escapada al final del valor tambien funciona', () => {
      const raw = '--note "trailing quote\\""';
      const tokens = tokenize(raw) as any[];
      expect(tokens[1].value).toBe('trailing quote"');
    });

    it('T09: multiples comillas escapadas en el mismo valor', () => {
      const raw = '--note "\\"a\\" and \\"b\\""';
      const tokens = tokenize(raw) as any[];
      expect(tokens[1].value).toBe('"a" and "b"');
    });

    it("T10: \\' dentro de comillas DOBLES no es especial (delimitador distinto)", () => {
      const raw = '--note "it\\\'s fine"';
      const tokens = tokenize(raw) as any[];
      // El backslash no precede al delimitador actual (") asi que queda literal.
      expect(tokens[1].value).toBe("it\\'s fine");
    });
  });

  describe('Backslashes comunes se preservan (NO es un escape general)', () => {
    it('T11: ruta de Windows con backslashes simples queda intacta', () => {
      const raw = 'workspace:cd --path "C:\\Users\\name"';
      const tokens = tokenize(raw) as any[];
      const pathToken = tokens.find(t => t.quoted);
      expect(pathToken.value).toBe('C:\\Users\\name');
    });

    it('T12: ruta UNC (doble backslash inicial) queda intacta', () => {
      const raw = 'workspace:cd --path "\\\\server\\share"';
      const tokens = tokenize(raw) as any[];
      const pathToken = tokens.find(t => t.quoted);
      expect(pathToken.value).toBe('\\\\server\\share');
    });

    it('T13: backslash seguido de letra (no la comilla delimitadora) queda literal', () => {
      const raw = '--regex "\\d+\\s*"';
      const tokens = tokenize(raw) as any[];
      expect(tokens[1].value).toBe('\\d+\\s*');
    });
  });
});

describe('quoteArg() — embebido seguro de valores arbitrarios', () => {
  it('QA01: un valor sin comillas ni backslashes hace round-trip sin cambios', () => {
    const raw = 'hello world';
    const tokens = tokenize(`--note ${quoteArg(raw)}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  it('QA02: un valor con comillas dobles embebidas hace round-trip exacto', () => {
    const raw = 'she said "hi" to me';
    const tokens = tokenize(`--note ${quoteArg(raw)}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  it('QA03: un valor con backslash-comilla crudo (sin escapar) hace round-trip exacto', () => {
    const raw = 'foo\\"bar'; // f,o,o,\,",b,a,r — backslash literal seguido de comilla
    const tokens = tokenize(`--note ${quoteArg(raw)}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  it('QA04: un valor que ya contiene la secuencia de escape hace round-trip exacto', () => {
    const raw = 'literal \\" sequence';
    const tokens = tokenize(`--note ${quoteArg(raw)}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  it('QA05: quoteArg con comilla simple como delimitador tambien hace round-trip', () => {
    const raw = "it's a \"test\"";
    const wrapped = quoteArg(raw, "'");
    const tokens = tokenize(`--note ${wrapped}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  it('QA06: un valor con rutas de Windows embebidas hace round-trip exacto', () => {
    const raw = 'C:\\Users\\name\\project.txt';
    const tokens = tokenize(`--path ${quoteArg(raw)}`) as any[];
    expect(tokens[1].value).toBe(raw);
  });

  /**
   * Regresion (auditoria post-tokenizer-fix): un valor terminado en
   * backslash literal SIEMPRE se fusiona con la comilla de cierre que
   * quoteArg agrega (scanQuoteChar decide char-por-char, sin contar pares —
   * no distingue "mi comilla de cierre" de "la apertura del siguiente
   * argumento"). Si el comando tenia MAS comillas mas adelante (el caso
   * normal al embeber 2+ campos no confiables en el mismo comando),
   * la region "abierta" absorbia en silencio flags/argumentos posteriores
   * como texto inerte — parse() devolvia un ParseResult exitoso, SIN
   * ParseError, con la estructura corrupta. Ahora quoteArg lanza en vez
   * de emitir ese output.
   */
  describe('QA08: valores terminados en backslash literal', () => {
    it('quoteArg lanza si el valor termina en un backslash', () => {
      expect(() => quoteArg('evil\\')).toThrow(/backslash/);
    });

    it('quoteArg lanza sin importar cuantos backslashes finales tenga (no es par/impar)', () => {
      expect(() => quoteArg('a\\')).toThrow();
      expect(() => quoteArg('a\\\\')).toThrow();
      expect(() => quoteArg('a\\\\\\')).toThrow();
    });

    it('un valor que SOLO termina en backslash en el MEDIO (no al final) sigue funcionando', () => {
      const raw = 'C:\\Users\\name'; // no termina en backslash
      expect(() => quoteArg(raw)).not.toThrow();
    });

    it('reproduce el escenario exacto reportado: dos campos con quoteArg en el mismo comando ya NO corrompe la estructura', () => {
      const title = 'evil\\'; // termina en backslash — antes del fix, esto se combinaba
      // con la comilla de cierre y dejaba la region abierta.
      expect(() => quoteArg(title)).toThrow();

      // Con el guard, el caller se entera EN quoteArg(), antes de construir
      // un comando corrupto — nunca llega a parse() con --confirm/--content
      // tragados en silencio.
    });
  });

  /**
   * Documenta el proposito real de este fix: agrega la CAPACIDAD de
   * embeber un valor arbitrario de forma segura (quoteArg), pero no
   * "arregla" retroactivamente a un caller que interpola texto crudo sin
   * usar esa funcion — eso es estructuralmente imposible (equivalente a
   * pedirle a un motor SQL que adivine que un string concatenado a mano
   * "en realidad" no queria ser una segunda sentencia). El fix es la
   * herramienta para hacerlo bien, no una proteccion automatica sobre
   * codigo que sigue interpolando texto crudo.
   */
  it('QA07: interpolar texto crudo (sin quoteArg) con una comilla sin escapar sigue siendo inseguro — por eso existe quoteArg', () => {
    const untrusted = 'x" --confirm --path "/etc/shadow';
    const naive = `file:read --path "safe.txt" --note "${untrusted}"`;
    const tokens = tokenize(naive) as any[];
    // El caracter '"' crudo en `untrusted` SIGUE cerrando el string ahi
    // mismo — el resto se re-tokeniza como flags/valores nuevos. Este test
    // no es una vulnerabilidad nueva: documenta por que la mitigacion es
    // "usa quoteArg", no "el tokenizer te salva de interpolar texto crudo".
    const flagValues = tokens.map(t => t.value);
    expect(flagValues).toContain('--confirm');
    expect(flagValues).toContain('/etc/shadow');

    // La MISMA data, embebida con quoteArg, queda como UN solo valor opaco.
    const safe = `file:read --path "safe.txt" --note ${quoteArg(untrusted)}`;
    const safeTokens = tokenize(safe) as any[];
    const noteValue = safeTokens[safeTokens.findIndex(t => t.value === '--note') + 1];
    expect(noteValue.value).toBe(untrusted);
    expect(safeTokens.map(t => t.value)).not.toContain('--confirm');
  });
});

describe('Consistencia tokenizer <-> segmentadores de parser/index.ts', () => {
  /**
   * Regresion: pipeline/batch/comma/jq splitters en parser/index.ts
   * rastreaban comillas con su propio chequeo ingenuo `ch === quote`,
   * independiente del tokenizador. Si solo el tokenizador entendiera
   * comillas escapadas, un valor con `>>`/`,`/`|` embebido (protegido por
   * una comilla escapada en algun punto anterior del mismo valor) podria
   * verse "cerrado" para el segmentador pero seguir abierto para el
   * tokenizador, dejando que el propio contenido reabra estructura de
   * pipeline/batch/jq que deberia ser dato inerte.
   */
  it('CQ01: un valor con ">>" embebido (via comilla escapada antes) no se trata como pipeline', () => {
    const raw = 'she said "hi" then >> more text';
    const cmd = `demo:cmd --note ${quoteArg(raw)}`;
    const result = parse(cmd) as any;
    expect(result.type).toBe('single');
    expect(result.commands[0].args.named.note).toBe(raw);
  });

  it('CQ02: un valor con "," embebido dentro de un batch no rompe la segmentacion', () => {
    const raw = 'a, b, c "quoted" here';
    const cmd = `batch [demo:cmd --note ${quoteArg(raw)}]`;
    const result = parse(cmd) as any;
    expect(result.type).toBe('batch');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].args.named.note).toBe(raw);
  });

  it('CQ03: un valor con "]" embebido dentro de un batch no cierra el batch antes de tiempo', () => {
    const raw = 'array notation like x]y "still quoted"';
    const cmd = `batch [demo:cmd --note ${quoteArg(raw)}]`;
    const result = parse(cmd) as any;
    expect(result.type).toBe('batch');
    expect(result.commands[0].args.named.note).toBe(raw);
  });

  it('CQ04: un valor con "|" embebido no se confunde con un filtro jq', () => {
    const raw = 'pipe-looking "quoted" | .field text';
    const cmd = `demo:cmd --note ${quoteArg(raw)}`;
    const result = parse(cmd) as any;
    expect(result.type).toBe('single');
    expect(result.commands[0].jqFilter).toBeNull();
    expect(result.commands[0].args.named.note).toBe(raw);
  });

  /**
   * Regresion (auditoria post-tokenizer-fix): el escenario real reportado
   * era embeber DOS campos no confiables con quoteArg en el MISMO comando.
   * Antes del guard de backslash final (QA08), si el primer campo terminaba
   * en backslash, su region quedaba "abierta" y absorbia en silencio el
   * flag --confirm y el segundo argumento --content, sin ningun ParseError.
   * Con ambos campos SIN backslash final, la estructura debe mantenerse
   * intacta: --confirm sigue siendo flag real, --content sigue siendo su
   * propio argumento.
   */
  it('CQ05: dos campos con quoteArg en el mismo comando no se mezclan entre si ni tragan flags posteriores', () => {
    const title = 'evil quote " inside';
    const content = 'a"b with more "quotes" here';
    const cmd = `notes:delete --title ${quoteArg(title)} --confirm --content ${quoteArg(content)}`;
    const result = parse(cmd) as any;

    expect(result.type).toBe('single');
    const parsed = result.commands[0];
    expect(parsed.args.named.title).toBe(title);
    expect(parsed.args.named.content).toBe(content);
    expect(parsed.flags.confirm).toBe(true);
  });
});
