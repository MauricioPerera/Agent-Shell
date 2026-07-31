/**
 * @module shared/handler-context
 * @description Forma unica del 3er argumento que Core y Executor le pasan a
 * los handlers de skills.
 *
 * Antes de este modulo cada engine tenia su propia convencion incompatible
 * para esa misma posicion: Core pasaba un `sessionId: string` crudo (para
 * que workspace.ts pudiera aislar su estado por sesion), Executor pasaba
 * `{ signal }` (agregado para cancelacion cooperativa en timeout). Un
 * handler generico no podia asumir ninguna de las dos formas sin romper
 * con el otro engine. Ninguna de las dos convenciones estaba documentada
 * en README.md, asi que unificarlas no rompe ningun contrato publico.
 */

export interface HandlerContext {
  sessionId?: string;
  signal?: AbortSignal;
}
