# Contrato: JQ_FILTER

> **Version**: 1.0
> **Fecha**: 2026-01-22
> **Estado**: Draft
> **Autor**: Arquitecto de Especificaciones
> **Modulo padre**: Agent Shell (Gateway)

## Resumen Ejecutivo

El modulo JQ Filter es el procesador de filtros post-ejecucion de Agent Shell. Recibe el output JSON de un comando ejecutado y aplica expresiones de filtrado con sintaxis compatible con un subset de jq, retornando unicamente los datos solicitados por el agente. Opera como ultimo paso del pipeline de ejecucion, entre el Executor y la respuesta final al agente LLM.

---

## 1. Que debe hacer? (MUST DO)

### 1.1 Objetivo Principal

Filtrar y extraer campos especificos de un output JSON utilizando una sintaxis compatible con jq, reduciendo la cantidad de datos (y por tanto tokens) que el agente recibe como respuesta.

### 1.2 Funcionalidades Requeridas

- [ ] **F01** - Extraccion de campo simple (`.campo`)
  - Acceder a una propiedad de primer nivel de un objeto JSON
  - Retornar el valor del campo en su tipo original
- [ ] **F02** - Extraccion de campos anidados (`.a.b.c`)
  - Navegar propiedades anidadas con notacion de punto
  - Soportar profundidad arbitraria
- [ ] **F03** - Acceso a elementos de array por indice (`.[N]`)
  - Acceder a un elemento especifico de un array por su posicion
  - Soportar indices base-0
- [ ] **F04** - Extraccion de multiples campos (`[.a, .b]`)
  - Extraer multiples campos en una sola expresion
  - Retornar un array con los valores extraidos
- [ ] **F05** - Iteracion de array (`.[].campo`)
  - Iterar sobre todos los elementos de un array
  - Extraer un campo especifico de cada elemento
  - Retornar un array con los valores extraidos
- [ ] **F06** - Identidad (`.`)
  - Retornar el input sin modificaciones
  - Util como base para composicion futura
- [ ] **F07** - Indice negativo en arrays (`.[-N]`)
  - Acceder a elementos desde el final del array
  - `[-1]` retorna el ultimo elemento

### 1.3 Sintaxis Soportada (Subset de jq)

```
EXPRESION              DESCRIPCION                    EJEMPLO
.                      Identidad (pass-through)       . -> input completo
.campo                 Campo de primer nivel          .name -> "Juan"
.a.b                   Campo anidado                  .user.email -> "j@x.com"
.[N]                   Indice de array (base 0)       .[0] -> primer elemento
.[-N]                  Indice negativo                .[-1] -> ultimo elemento
.[].campo              Iteracion + campo              .[].id -> [1, 2, 3]
[.a, .b]              Multiples campos               [.name, .age] -> ["Juan", 30]
.[].a.b               Iteracion + anidado            .[].user.name -> ["Juan", "Ana"]
```

### 1.4 Flujo Principal

```
Input JSON (string/object)
        |
        v
+------------------+
| Parse Expression |---> Error si sintaxis invalida (E001)
+------------------+
        |
        v
+------------------+
| Validate Input   |---> Error si no es JSON valido (E002)
+------------------+
        |
        v
+------------------+
| Apply Filter     |---> Error si path no existe (E003)
+------------------+     Error si tipo incompatible (E004)
        |
        v
   Output filtrado
```

### 1.5 Inputs y Outputs

| Input | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `data` | object / array / string (JSON) | Si | El output JSON del comando ejecutado |
| `expression` | string | Si | La expresion de filtrado jq |

| Output | Tipo | Descripcion |
|--------|------|-------------|
| `result` | any (JSON value) | El valor extraido tras aplicar el filtro |
| `error` | object `{code, message, path}` | Objeto de error si la operacion falla |

### 1.6 Ejemplos Detallados por Operacion

#### F01 - Campo simple

```json
// Input
{"name": "Juan", "age": 30, "city": "Madrid"}

// Expression: .name
// Output: "Juan"

// Expression: .age
// Output: 30
```

#### F02 - Campos anidados

```json
// Input
{"user": {"profile": {"email": "j@example.com", "verified": true}}}

// Expression: .user.profile.email
// Output: "j@example.com"

// Expression: .user.profile.verified
// Output: true
```

#### F03 - Indice de array

```json
// Input
{"items": ["apple", "banana", "cherry"]}

// Expression: .items.[0]
// Output: "apple"

// Expression: .items.[2]
// Output: "cherry"
```

```json
// Input (array raiz)
[{"id": 1}, {"id": 2}, {"id": 3}]

// Expression: .[0]
// Output: {"id": 1}

// Expression: .[1].id
// Output: 2
```

#### F04 - Multiples campos

```json
// Input
{"name": "Juan", "age": 30, "city": "Madrid", "country": "Spain"}

// Expression: [.name, .age]
// Output: ["Juan", 30]

// Expression: [.city, .country]
// Output: ["Madrid", "Spain"]
```

#### F05 - Iteracion de array

```json
// Input
{"users": [{"name": "Juan", "age": 30}, {"name": "Ana", "age": 25}]}

// Expression: .users.[].name
// Output: ["Juan", "Ana"]

// Expression: .users.[].age
// Output: [30, 25]
```

```json
// Input (array raiz)
[{"id": 1, "status": "active"}, {"id": 2, "status": "inactive"}]

// Expression: .[].id
// Output: [1, 2]

// Expression: .[].status
// Output: ["active", "inactive"]
```

#### F06 - Identidad

```json
// Input
{"name": "Juan"}

// Expression: .
// Output: {"name": "Juan"}
```

#### F07 - Indice negativo

```json
// Input
[10, 20, 30, 40, 50]

// Expression: .[-1]
// Output: 50

// Expression: .[-2]
// Output: 40
```

#### Combinaciones

```json
// Input
{"data": {"users": [{"name": "Juan", "roles": ["admin", "user"]}, {"name": "Ana", "roles": ["user"]}]}}

// Expression: .data.users.[0].name
// Output: "Juan"

// Expression: .data.users.[].name
// Output: ["Juan", "Ana"]

// Expression: .data.users.[0].roles.[0]
// Output: "admin"
```

---

## 2. Que NO debe hacer? (MUST NOT)

### 2.1 Fuera de Alcance (Sintaxis jq NO soportada)

- No implementar pipe interno (`|` dentro de expresion jq)
- No implementar funciones jq (`length`, `keys`, `values`, `map`, `select`, `sort_by`, etc.)
- No implementar operadores aritmeticos (`+`, `-`, `*`, `/`)
- No implementar operadores de comparacion (`==`, `!=`, `>`, `<`)
- No implementar condicionales (`if-then-else`)
- No implementar try-catch de jq
- No implementar string interpolation (`\(expr)`)
- No implementar recursive descent (`..`)
- No implementar slice de arrays (`.[2:5]`)
- No implementar object construction (`{name: .field}`)
- No implementar `?` (optional operator)
- No implementar `//` (alternative operator)

### 2.2 Anti-patterns Prohibidos

- No ejecutar codigo arbitrario desde la expresion de filtro - el filtro es puramente declarativo
- No mutar el input original - siempre trabajar sobre una copia o acceso de solo lectura
- No retornar `undefined` o `null` silenciosamente cuando un campo no existe - siempre generar un error explicito
- No parsear la expresion con `eval()` o equivalentes - usar un parser dedicado
- No aceptar expresiones con longitud mayor a 256 caracteres - rechazar con error
- No realizar operaciones de I/O dentro del filtro (no leer archivos, no hacer requests)

### 2.3 Restricciones de Implementacion

- No depender de la libreria jq del sistema operativo (la implementacion debe ser nativa al lenguaje del proyecto)
- No utilizar recursion sin limite de profundidad (maximo 20 niveles de anidamiento)
- No cachear resultados entre llamadas (cada invocacion es stateless)
- No modificar el modulo Executor - JQ Filter recibe datos ya ejecutados

---

## 3. Como se que esta bien? (ACCEPTANCE)

### 3.1 Criterios de Aceptacion

```gherkin
Scenario: Extraccion de campo simple
  DADO un JSON {"name": "Juan", "age": 30}
  CUANDO aplico la expresion ".name"
  ENTONCES retorna "Juan"

Scenario: Extraccion de campo anidado
  DADO un JSON {"user": {"profile": {"email": "j@x.com"}}}
  CUANDO aplico la expresion ".user.profile.email"
  ENTONCES retorna "j@x.com"

Scenario: Acceso a array por indice
  DADO un JSON [{"id": 1}, {"id": 2}]
  CUANDO aplico la expresion ".[0]"
  ENTONCES retorna {"id": 1}

Scenario: Indice negativo
  DADO un JSON [10, 20, 30]
  CUANDO aplico la expresion ".[-1]"
  ENTONCES retorna 30

Scenario: Multiples campos
  DADO un JSON {"name": "Juan", "age": 30, "city": "Madrid"}
  CUANDO aplico la expresion "[.name, .city]"
  ENTONCES retorna ["Juan", "Madrid"]

Scenario: Iteracion de array
  DADO un JSON {"items": [{"id": 1}, {"id": 2}, {"id": 3}]}
  CUANDO aplico la expresion ".items.[].id"
  ENTONCES retorna [1, 2, 3]

Scenario: Identidad
  DADO un JSON {"data": 42}
  CUANDO aplico la expresion "."
  ENTONCES retorna {"data": 42}

Scenario: Campo inexistente genera error
  DADO un JSON {"name": "Juan"}
  CUANDO aplico la expresion ".email"
  ENTONCES retorna error con codigo E003 y path ".email"

Scenario: Tipo incompatible genera error
  DADO un JSON {"name": "Juan"}
  CUANDO aplico la expresion ".name.[0]"
  ENTONCES retorna error con codigo E004 indicando que "string" no es indexable

Scenario: Expresion invalida genera error
  DADO cualquier JSON valido
  CUANDO aplico la expresion "..invalid[["
  ENTONCES retorna error con codigo E001

Scenario: Input no es JSON valido
  DADO un string "esto no es json {"
  CUANDO aplico cualquier expresion
  ENTONCES retorna error con codigo E002
```

### 3.2 Casos de Prueba Requeridos

| ID | Escenario | Input | Expression | Output Esperado | Prioridad |
|----|-----------|-------|------------|-----------------|-----------|
| T01 | Campo simple string | `{"name":"Juan"}` | `.name` | `"Juan"` | Alta |
| T02 | Campo simple number | `{"age":30}` | `.age` | `30` | Alta |
| T03 | Campo simple boolean | `{"active":true}` | `.active` | `true` | Alta |
| T04 | Campo simple null | `{"val":null}` | `.val` | `null` | Alta |
| T05 | Anidado 2 niveles | `{"a":{"b":1}}` | `.a.b` | `1` | Alta |
| T06 | Anidado 3 niveles | `{"a":{"b":{"c":"x"}}}` | `.a.b.c` | `"x"` | Alta |
| T07 | Array indice 0 | `[10,20,30]` | `.[0]` | `10` | Alta |
| T08 | Array indice medio | `[10,20,30]` | `.[1]` | `20` | Media |
| T09 | Array indice -1 | `[10,20,30]` | `.[-1]` | `30` | Alta |
| T10 | Array campo anidado | `{"a":[{"x":1}]}` | `.a.[0].x` | `1` | Alta |
| T11 | Multiples campos | `{"a":1,"b":2,"c":3}` | `[.a, .c]` | `[1, 3]` | Alta |
| T12 | Iteracion campo | `[{"id":1},{"id":2}]` | `.[].id` | `[1, 2]` | Alta |
| T13 | Iteracion anidado | `{"r":[{"n":"A"},{"n":"B"}]}` | `.r.[].n` | `["A","B"]` | Alta |
| T14 | Identidad | `{"x":1}` | `.` | `{"x":1}` | Media |
| T15 | Campo inexistente | `{"a":1}` | `.b` | Error E003 | Alta |
| T16 | Indice fuera de rango | `[1,2]` | `.[5]` | Error E003 | Alta |
| T17 | Tipo incompatible | `{"a":"str"}` | `.a.b` | Error E004 | Alta |
| T18 | Indice en no-array | `{"a":1}` | `.a.[0]` | Error E004 | Alta |
| T19 | Expresion vacia | `{"a":1}` | `` | Error E001 | Media |
| T20 | Expresion invalida | `{"a":1}` | `...a` | Error E001 | Media |
| T21 | Input no-JSON | `"not json {"` | `.a` | Error E002 | Alta |
| T22 | Objeto vacio | `{}` | `.a` | Error E003 | Media |
| T23 | Array vacio iterado | `[]` | `.[].id` | `[]` | Media |
| T24 | Null en path intermedio | `{"a":null}` | `.a.b` | Error E004 | Alta |
| T25 | Expresion demasiado larga | `{"a":1}` | (257 chars) | Error E001 | Baja |

### 3.3 Metricas de Exito

- [ ] Tiempo de filtrado < 5ms para JSON de hasta 1MB
- [ ] Tiempo de filtrado < 50ms para JSON de hasta 10MB
- [ ] 100% de los tests T01-T25 pasando
- [ ] 0 falsos positivos en deteccion de errores (no generar error cuando el path es valido)
- [ ] 0 falsos negativos en deteccion de errores (no retornar null/undefined cuando el path no existe)

### 3.4 Definition of Done

- [ ] Todas las operaciones F01-F07 implementadas
- [ ] Todos los tests T01-T25 pasando
- [ ] Cobertura de tests >= 95% en el modulo
- [ ] Manejo de errores E001-E004 implementado con mensajes claros
- [ ] Documentacion del subset de sintaxis soportada
- [ ] Integracion con el pipeline Executor -> JQ Filter -> Response verificada
- [ ] Sin dependencias externas para el parsing de expresiones
- [ ] Benchmarks de rendimiento ejecutados y dentro de limites

---

## 4. Que pasa si falla? (ERROR HANDLING)

### 4.1 Errores Esperados

| Codigo | Condicion | Mensaje Template | Accion del Agente |
|--------|-----------|------------------|-------------------|
| E001 | Expresion de filtro con sintaxis invalida | `"Invalid filter expression: '{expr}'. Supported syntax: .field, .a.b, .[N], .[].field, [.a, .b]"` | Corregir la expresion y reintentar |
| E002 | Input no es JSON valido | `"Input is not valid JSON. Cannot apply filter."` | Verificar que el comando ejecutado retorno JSON valido |
| E003 | Path no existe en el JSON | `"Path '{path}' not found in input. Available keys: [{keys}]"` | Usar un path existente (se muestran las keys disponibles) |
| E004 | Tipo incompatible con la operacion | `"Cannot apply '{operation}' on type '{type}' at path '{path}'. Expected '{expected_type}'."` | Ajustar la expresion al tipo real del dato |

### 4.2 Respuesta de Error (Estructura)

```json
{
  "success": false,
  "error": {
    "code": "E003",
    "message": "Path '.email' not found in input. Available keys: [name, age, city]",
    "expression": ".email",
    "path_resolved": ".",
    "path_failed": ".email",
    "available_keys": ["name", "age", "city"]
  }
}
```

### 4.3 Respuesta Exitosa (Estructura)

```json
{
  "success": true,
  "result": <valor_filtrado>,
  "expression": ".user.name",
  "input_type": "object"
}
```

### 4.4 Estrategia de Fallback

- Si el input es un string que parece JSON pero falla el parsing, incluir en el error los primeros 100 caracteres del input para diagnostico
- Si el array esta vacio y se aplica iteracion (`.[].campo`), retornar array vacio `[]` (no es error)
- Si la expresion es `.` (identidad), retornar el input sin procesamiento adicional

### 4.5 Logging

- Nivel INFO: Cada filtro aplicado exitosamente (expression, tiempo de ejecucion en ms)
- Nivel WARN: Filtros sobre JSON > 1MB (puede afectar rendimiento)
- Nivel ERROR: Todos los codigos E001-E004 con contexto completo
- Nunca loguear el contenido completo del JSON (puede contener datos sensibles). Solo loguear keys de primer nivel

### 4.6 Limites de Seguridad en Errores

- El campo `available_keys` en E003 solo muestra keys del nivel donde fallo, no del objeto completo
- Nunca incluir valores de los datos en mensajes de error, solo nombres de campos
- Truncar el mensaje de error a 500 caracteres maximo

---

## 5. Que supuestos tiene? (ASSUMPTIONS)

### 5.1 Precondiciones

- [ ] El Executor ya ejecuto el comando y produjo output
- [ ] El output del Executor es un string JSON valido o un objeto ya parseado
- [ ] La expresion de filtro fue extraida por el Parser del comando original (despues del `|`)
- [ ] El sistema tiene suficiente memoria para mantener el JSON en memoria

### 5.2 Dependencias

| Dependencia | Tipo | Version | Critica | Notas |
|-------------|------|---------|---------|-------|
| Parser (modulo) | Interno | - | Si | Extrae la expresion del pipe `\|` |
| Executor (modulo) | Interno | - | Si | Provee el JSON de input |
| JSON parser del lenguaje | Stdlib | - | Si | Para parsear strings JSON |

### 5.3 Datos de Entrada Esperados

- **Formato del data**: JSON valido (object, array, o valor primitivo en raiz)
- **Encoding**: UTF-8
- **Tamano maximo de input**: 10MB (rechazar con error si excede)
- **Profundidad maxima de anidamiento del JSON**: 50 niveles
- **Profundidad maxima de la expresion**: 20 segmentos (`.a.b.c...` hasta 20)

### 5.4 Formato de la Expresion

La expresion llega como string limpio, ya parseado por el modulo Parser:
- Sin el caracter pipe `|` inicial
- Sin espacios leading/trailing (ya trimmeado)
- Ejemplos: `.name`, `.users.[0].email`, `[.a, .b]`

### 5.5 Estado del Sistema

- No requiere autenticacion (opera sobre datos ya autorizados por el Executor)
- No requiere estado de sesion (stateless)
- No requiere acceso a disco ni red
- No requiere configuracion especial (zero-config)

---

## 6. Que limites tiene? (CONSTRAINTS)

### 6.1 Limites Tecnicos

| Limite | Valor | Razon |
|--------|-------|-------|
| Tamano maximo de input JSON | 10 MB | Prevenir OOM en el gateway |
| Longitud maxima de expresion | 256 caracteres | Prevenir abuse, ninguna expresion legitima del subset es tan larga |
| Profundidad maxima de navegacion | 20 niveles | Prevenir stack overflow en implementaciones recursivas |
| Tiempo maximo de ejecucion | 100ms | El filtro no debe ser bottleneck del pipeline |
| Elementos maximos en iteracion | 10,000 | Prevenir respuestas excesivamente grandes |
| Campos maximos en multi-select | 20 | `[.a, .b, ...]` limitado a 20 campos |

### 6.2 Limites de Negocio

- El filtro solo reduce datos, nunca los transforma ni agrega
- El filtro no altera tipos (si `.age` es number, el output es number)
- El resultado de iteracion siempre es un array, incluso si tiene un solo elemento
- Los valores `null` en JSON son valores validos (no confundir con "campo inexistente")

### 6.3 Limites de Seguridad

- El filtro no debe permitir inyeccion de codigo a traves de la expresion
- El filtro no tiene acceso al filesystem ni a la red
- Los mensajes de error no deben exponer valores de datos, solo estructura (keys)
- El parser de expresiones debe usar una gramatica formal, no regex adhoc ni eval

### 6.4 Limites de Alcance (Version 1.0)

**Esta version NO incluye:**
- Pipe dentro de expresiones (`| select(...)`)
- Funciones built-in de jq
- Slicing de arrays (`.[2:5]`)
- Object construction (`{key: .value}`)
- Operadores logicos/aritmeticos
- Recursive descent (`..`)
- String interpolation
- Optional operator (`?`)
- Alternative operator (`//`)
- Asignacion/update (`|=`, `+=`)

**Consideraciones para versiones futuras:**
- v1.1: Slicing de arrays (`.[2:5]`), optional operator (`.field?`)
- v1.2: Object construction (`{newkey: .oldkey}`)
- v1.3: Funciones basicas (`length`, `keys`, `values`, `type`)
- v2.0: `select()`, `map()`, pipe interno

---

## 7. Gramatica Formal del Subset

```ebnf
expression     = identity | field_access | array_access | multi_select | iteration ;

identity       = "." ;

field_access   = "." , field_name , { "." , field_name } ;
field_name     = letter , { letter | digit | "_" | "-" } ;

array_access   = accessor , "[" , index , "]" , [ "." , field_access ] ;
accessor       = field_access | "." ;
index          = integer ;
integer        = [ "-" ] , digit , { digit } ;

iteration      = accessor , "[]" , [ "." , field_access ] ;

multi_select   = "[" , expression , { "," , expression } , "]" ;

letter         = "a"-"z" | "A"-"Z" ;
digit          = "0"-"9" ;
```

### Notas sobre la gramatica:
- `field_name` soporta letras, digitos, guion bajo y guion medio
- Los indices de array son enteros (positivos y negativos)
- `multi_select` puede contener cualquier expresion valida como elemento
- La iteracion `[]` (sin indice) itera todos los elementos

---

## Anexos

### A. Glosario

| Termino | Definicion |
|---------|------------|
| Expression | String con sintaxis jq-like que describe que datos extraer |
| Path | Secuencia de segmentos que navegan la estructura JSON (ej: `.user.name`) |
| Segment | Cada parte de un path separada por `.` (ej: `user`, `name`) |
| Iteration | Operacion que aplica un path a cada elemento de un array |
| Multi-select | Operacion que extrae multiples campos en un solo array resultado |
| Identity | La expresion `.` que retorna el input sin cambios |
| Resolver | El componente interno que navega el JSON siguiendo un path |

### B. Referencias

- [PRD Agent Shell](../docs/prd.md) - Seccion "Filtrado de output" y "JQ Filter"
- [Contrato Parser](./parser.md) - Como se extrae la expresion del comando
- [Manual jq](https://stedolan.github.io/jq/manual/) - Referencia del lenguaje jq completo (solo subset implementado)

### C. Integracion con el Pipeline

```
cli_exec("users:list --active | .users.[].name")
         |                       |
         v                       v
      Parser extrae:          Parser extrae:
      cmd = "users:list"      filter = ".users.[].name"
      args = {active: true}
         |
         v
      Executor ejecuta cmd
      retorna JSON completo
         |
         v
      JQ Filter aplica ".users.[].name"
      retorna ["Juan", "Ana", "Carlos"]
         |
         v
      Response al agente: ["Juan", "Ana", "Carlos"]
```

### D. Historial de Cambios

| Version | Fecha | Autor | Cambios |
|---------|-------|-------|---------|
| 1.0 | 2026-01-22 | Arquitecto de Especificaciones | Version inicial del contrato |

---

## 9. Estado de Implementación v1.0

### Implementado
- applyFilter() con firma correcta
- Todos los features F01-F07: campo simple, anidado, indice array, multi-select, iteracion, identidad, indice negativo
- Todos los 25 test cases (T01-T25) soportados
- Error codes E001-E004 con mensajes exactos del contrato
- Limites enforzados: MAX_EXPRESSION_LENGTH=256, MAX_PATH_DEPTH=20, MAX_MULTI_SELECT_FIELDS=20, MAX_INPUT_SIZE=10MB
- Rechazo correcto de sintaxis no soportada (pipe, object construction, slicing)
- Validacion de field names contra regex `[a-zA-Z_][a-zA-Z0-9_-]*`

### Implementado (v1.1)
- Soporte de indices de array en field paths del parser (`.[0].name`) — validacion en capa parser

### Pendiente
- Logging (INFO para filtro exitoso, WARN para JSON > 1MB, ERROR para E001-E004)
- Aceptar input como JSON string (actualmente retorna E002 para strings JSON validos)
