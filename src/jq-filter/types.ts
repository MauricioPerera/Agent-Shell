/**
 * @module jq-filter/types
 * @description Tipos del modulo JQ Filter de Agent Shell.
 *
 * Define la estructura de respuestas (exito/error) y los segmentos
 * internos del path de navegacion sobre JSON.
 */

/** Respuesta exitosa de un filtro aplicado. */
export interface FilterSuccess {
  success: true;
  result: any;
  expression: string;
  input_type: string;
}

/** Respuesta de error cuando el filtro no puede aplicarse. */
export interface FilterError {
  success: false;
  error: {
    code: string;
    message: string;
    expression?: string;
    path_resolved?: string;
    path_failed?: string;
    available_keys?: string[];
  };
}

/** Union type: resultado de aplicar un filtro jq. */
export type FilterResult = FilterSuccess | FilterError;

// --- Segmentos internos del path parseado ---

/** Acceso a un campo por nombre: `.campo` */
export interface FieldSegment {
  type: 'field';
  name: string;
}

/** Acceso a un indice de array: `.[N]` o `.[-N]` */
export interface IndexSegment {
  type: 'index';
  index: number;
}

/** Iteracion sobre todos los elementos: `.[]` */
export interface IterationSegment {
  type: 'iteration';
}

/** Un segmento del path de navegacion. */
export type PathSegment = FieldSegment | IndexSegment | IterationSegment;

/** Una expresion parseada: puede ser un path simple o un multi-select. */
export interface ParsedExpression {
  type: 'path' | 'identity' | 'multi_select';
  segments: PathSegment[];         // Para path/identity
  subExpressions: ParsedExpression[]; // Para multi_select
}

/** Longitud maxima de expresion aceptada. */
export const MAX_EXPRESSION_LENGTH = 256;

/** Profundidad maxima de navegacion (segmentos en un path). */
export const MAX_PATH_DEPTH = 20;

/** Campos maximos en un multi-select. */
export const MAX_MULTI_SELECT_FIELDS = 20;

/** Tamano maximo de input JSON en bytes (10MB). */
export const MAX_INPUT_SIZE_BYTES = 10 * 1024 * 1024;
