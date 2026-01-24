-- ============================================================================
-- Schema: Agent Shell - Persistence Layer
-- Contracts: command-registry v1.0, vector-index v1.0, context-store v1.0,
--            security v1.0
-- PRD: Agent Shell (AI-first CLI framework)
-- Generated: 2026-01-22
-- Updated: 2026-01-23
-- Compatibility: SQLite / PostgreSQL (generic SQL)
-- ============================================================================

-- NOTA: Este schema cubre los modulos que requieren persistencia a disco/DB.
-- El Command Registry en v1.0 es in-memory, pero esta tabla permite
-- persistencia opcional para cold-start rapido (serializacion del registry).
-- El Vector Index usa adapters (pgvector, SQLite-vec, etc.) pero esta tabla
-- almacena la metadata de embeddings de forma agnostica al backend vectorial.
-- El Context Store persiste estado de sesion via sus storage adapters.


-- ============================================================================
-- TABLE: commands
-- Contract ref: command-registry.md (Seccion 1.3 CommandDefinition)
-- Purpose: Registro persistente de definiciones de comandos con su metadata
--          completa. Fuente de verdad para reconstruir el registry in-memory
--          y alimentar al Vector Index.
-- ============================================================================

CREATE TABLE IF NOT EXISTS commands (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identidad del comando (constraint unico: namespace + name + version)
    namespace       TEXT NOT NULL,           -- Agrupacion logica (ej: "users", "orders")
                                             -- Formato: ^[a-z][a-z0-9-]{0,49}$
    name            TEXT NOT NULL,           -- Nombre del comando (ej: "create", "list")
                                             -- Formato: ^[a-z][a-z0-9-]{0,49}$
    version         TEXT NOT NULL,           -- Semver del comando (ej: "1.0.0")
                                             -- Formato: X.Y.Z donde X,Y,Z >= 0

    -- Descripcion
    description     TEXT NOT NULL,           -- Una linea concisa para el LLM (max 200 chars)
    long_description TEXT,                   -- Descripcion extendida (para help detallado)

    -- Parametros (almacenados como JSON array de CommandParam)
    -- Cada elemento: {name, type, required, default?, constraints?, description?}
    -- Tipos validos: int, float, string, bool, date, json, enum(...), array<tipo>
    params          TEXT NOT NULL DEFAULT '[]',  -- JSON: CommandParam[]

    -- Output shape del comando
    -- Formato: {type: string, description?: string}
    output_shape    TEXT NOT NULL DEFAULT '{}',  -- JSON: OutputShape

    -- Ejemplo de uso real con filtro jq incluido
    example         TEXT NOT NULL,           -- Ej: 'users:create --name "John" | .id'

    -- Metadata adicional
    -- Campos opcionales como reversible, requiresConfirmation, deprecated, etc.
    metadata        TEXT NOT NULL DEFAULT '{}',  -- JSON: {reversible, requiresConfirmation,
                                                 --        deprecated, deprecatedMessage, ...}

    -- Tags para busqueda semantica adicional (array de strings)
    tags            TEXT NOT NULL DEFAULT '[]',  -- JSON: string[]

    -- Timestamps
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Constraints
    CONSTRAINT commands_unique_identity UNIQUE (namespace, name, version),
    CONSTRAINT commands_namespace_format CHECK (LENGTH(namespace) >= 1 AND LENGTH(namespace) <= 50),
    CONSTRAINT commands_name_format CHECK (LENGTH(name) >= 1 AND LENGTH(name) <= 50),
    CONSTRAINT commands_version_nonempty CHECK (LENGTH(version) >= 5),  -- minimo "0.0.0"
    CONSTRAINT commands_description_nonempty CHECK (LENGTH(description) >= 1),
    CONSTRAINT commands_example_nonempty CHECK (LENGTH(example) >= 1)
);

-- Indice para lookup O(1) por namespace:name (sin version, retorna la mas reciente)
CREATE INDEX IF NOT EXISTS idx_commands_ns_name
    ON commands(namespace, name);

-- Indice para listado por namespace
CREATE INDEX IF NOT EXISTS idx_commands_namespace
    ON commands(namespace);

-- Indice para busqueda por tags (requiere busqueda LIKE o JSON functions)
-- En PostgreSQL se usaria GIN index sobre jsonb; en SQLite se usa LIKE
CREATE INDEX IF NOT EXISTS idx_commands_created
    ON commands(created_at);


-- ============================================================================
-- TABLE: command_embeddings
-- Contract ref: vector-index.md (Seccion 1.4 VectorEntry, 1.7 Texto Indexable)
-- Purpose: Almacena los embeddings vectoriales de cada comando para busqueda
--          semantica. El vector se almacena como JSON array de floats (portable)
--          o como BLOB binario segun el adapter.
--          En PostgreSQL con pgvector se usaria tipo VECTOR(N).
-- ============================================================================

CREATE TABLE IF NOT EXISTS command_embeddings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Referencia al comando indexado
    command_id      INTEGER NOT NULL,        -- FK a commands.id

    -- Texto compuesto usado para generar el embedding
    -- Construido con: description | namespace:command | params | tags | examples
    -- Ref: vector-index.md seccion 1.7 buildIndexableText()
    indexable_text  TEXT NOT NULL,            -- Texto fuente del embedding (max 2000 chars)

    -- Vector de embedding serializado
    -- Opcion A (portable): JSON array de floats en TEXT, ej: [0.123, -0.456, ...]
    -- Opcion B (performance): BLOB de Float32Array (usado por demo/adapters/sqlite-*)
    --   El BLOB almacena N floats * 4 bytes = N*4 bytes (ej: 384 dims = 1536 bytes)
    --   Ventaja: ~4x menos espacio, carga directa sin JSON.parse
    -- En PostgreSQL: Se recomienda migrar a tipo VECTOR(N) con pgvector extension
    -- Dimension tipica: 256-1536 segun modelo (OpenAI ada-002 = 1536, etc.)
    embedding_vector TEXT NOT NULL,           -- TEXT (JSON) o BLOB (Float32Array)
                                              -- Depende del VectorStorageAdapter usado

    -- Metadata del embedding
    dimensions      INTEGER NOT NULL,        -- Cantidad de dimensiones del vector
    model_id        TEXT NOT NULL DEFAULT 'unknown',  -- Modelo usado (ej: "text-embedding-ada-002")

    -- Timestamps
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Constraints
    CONSTRAINT embeddings_command_unique UNIQUE (command_id),  -- 1 embedding por comando
    CONSTRAINT embeddings_dimensions_positive CHECK (dimensions > 0),
    CONSTRAINT embeddings_text_nonempty CHECK (LENGTH(indexable_text) >= 1),

    -- Foreign key
    CONSTRAINT fk_embeddings_command
        FOREIGN KEY (command_id) REFERENCES commands(id)
        ON DELETE CASCADE
);

-- Indice para lookup rapido por command_id
CREATE INDEX IF NOT EXISTS idx_embeddings_command_id
    ON command_embeddings(command_id);

-- Indice para filtrar por modelo (util cuando se cambia de modelo y se necesita rebuild)
CREATE INDEX IF NOT EXISTS idx_embeddings_model
    ON command_embeddings(model_id);

-- Indice por fecha de actualizacion (para delta sync)
CREATE INDEX IF NOT EXISTS idx_embeddings_updated
    ON command_embeddings(updated_at);


-- ============================================================================
-- TABLE: session_context
-- Contract ref: context-store.md (Seccion 7.1 ContextData, ContextEntry)
-- Purpose: Almacena pares clave-valor del contexto de sesion. Cada sesion
--          del agente tiene su propio conjunto de entradas. Soporta valores
--          JSON-serializables de cualquier tipo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_context (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identidad de la sesion
    session_id      TEXT NOT NULL,           -- UUID de la sesion activa

    -- Par clave-valor
    key             TEXT NOT NULL,           -- Nombre de la clave
                                             -- Formato: ^[a-zA-Z][a-zA-Z0-9._-]*$ (1-128 chars)
    value           TEXT NOT NULL,           -- Valor serializado como JSON
                                             -- Tipos: string, number, boolean, object, array
                                             -- Tamano maximo: 64 KB

    -- Metadata de la entrada
    value_type      TEXT NOT NULL DEFAULT 'string',  -- Tipo inferido: string|number|boolean|object|array
    version         INTEGER NOT NULL DEFAULT 1,      -- Incrementa en cada update de esta key

    -- Timestamps
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Constraints
    CONSTRAINT context_unique_key_per_session UNIQUE (session_id, key),
    CONSTRAINT context_session_nonempty CHECK (LENGTH(session_id) >= 1),
    CONSTRAINT context_key_nonempty CHECK (LENGTH(key) >= 1 AND LENGTH(key) <= 128),
    CONSTRAINT context_value_type_valid CHECK (
        value_type IN ('string', 'number', 'boolean', 'object', 'array')
    )
);

-- Indice principal: buscar por sesion + clave (covered by UNIQUE constraint)
-- Indice adicional para listar todo el contexto de una sesion
CREATE INDEX IF NOT EXISTS idx_context_session
    ON session_context(session_id);

-- Indice para limpiar sesiones antiguas
CREATE INDEX IF NOT EXISTS idx_context_updated
    ON session_context(updated_at);


-- ============================================================================
-- TABLE: command_history
-- Contract ref: context-store.md (Seccion 7.2 HistoryEntry)
-- Implementation ref: src/context-store/sqlite-storage-adapter.ts (lines 35-50)
-- Purpose: Registro cronologico de todos los comandos ejecutados por sesion.
--          Almacena el comando raw, namespace, argumentos, codigo de salida,
--          y si el comando es reversible (undoable).
--          Limite: 10000 entradas por sesion (FIFO, las antiguas se descartan).
-- ============================================================================

CREATE TABLE IF NOT EXISTS command_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identidad
    session_id      TEXT NOT NULL,           -- UUID de la sesion
    command_id      TEXT NOT NULL,           -- ID unico del comando ejecutado (ej: "cmd_001")

    -- Comando ejecutado
    command_raw     TEXT NOT NULL,           -- Comando completo como string
                                             -- Ej: 'users:create --name "John" --email j@t.com'
    namespace       TEXT NOT NULL DEFAULT '',     -- Namespace del comando (ej: "users")
    args            TEXT NOT NULL DEFAULT '{}',   -- JSON: Argumentos parseados {key: value, ...}

    -- Resultado de la ejecucion
    exit_code       INTEGER NOT NULL DEFAULT 0,   -- Codigo de salida (0=ok, 1=syntax, 2=not_found,
                                                  --                    3=no_perms, 4=needs_confirm)
    duration_ms     INTEGER NOT NULL DEFAULT 0,   -- Duracion de ejecucion en milisegundos
    result_summary  TEXT NOT NULL DEFAULT '',      -- Resumen del resultado (max 256 chars)

    -- Undo support
    undoable        INTEGER NOT NULL DEFAULT 0,   -- 1 si el comando soporta undo, 0 si no
    undo_status     TEXT DEFAULT NULL,       -- NULL | 'available' | 'applied' | 'expired'
    snapshot_id     TEXT DEFAULT NULL,        -- Referencia a undo_snapshots.id (si aplica)

    -- Timestamps
    executed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Constraints
    UNIQUE (session_id, command_id)
);

-- Indice para consultar historial de una sesion ordenado cronologicamente
CREATE INDEX IF NOT EXISTS idx_history_session_time
    ON command_history(session_id, executed_at DESC);

-- Indice para buscar un comando especifico por su ID (para undo)
CREATE INDEX IF NOT EXISTS idx_history_command_id
    ON command_history(session_id, command_id);

-- Indice para encontrar comandos reversibles pendientes
CREATE INDEX IF NOT EXISTS idx_history_undoable
    ON command_history(session_id, reversible, undo_status)
    WHERE reversible = 1;

-- Indice para limpieza FIFO (descartar los mas antiguos)
CREATE INDEX IF NOT EXISTS idx_history_executed
    ON command_history(executed_at);


-- ============================================================================
-- TABLE: undo_snapshots
-- Contract ref: context-store.md (Seccion 7.3 UndoSnapshot)
-- Implementation ref: src/context-store/sqlite-storage-adapter.ts (lines 52-60)
-- Purpose: Almacena snapshots del estado previo para comandos reversibles.
--          Separada de command_history para no inflar esa tabla con datos
--          potencialmente grandes. Referenciada desde command_history.snapshot_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS undo_snapshots (
    id              TEXT PRIMARY KEY,         -- UUID del snapshot

    -- Identidad
    session_id      TEXT NOT NULL,            -- UUID de la sesion
    command_id      TEXT NOT NULL,            -- Referencia al command_id en command_history

    -- Estado previo capturado antes de la ejecucion del comando
    -- Contiene toda la informacion necesaria para revertir la operacion
    state_before    TEXT NOT NULL DEFAULT '{}',  -- JSON: {key: value, ...} estado relevante
                                                 -- Tamano maximo recomendado: 64 KB

    -- Comando inverso (opcional, si existe un comando que revierte la operacion)
    rollback_command TEXT DEFAULT NULL,       -- Comando inverso a ejecutar
                                             -- Ej: 'config:set theme light' para revertir 'config:set theme dark'

    -- Metadata adicional del snapshot
    metadata        TEXT NOT NULL DEFAULT '{}',  -- JSON: Informacion adicional del handler

    -- Timestamps
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Indice para buscar snapshots por sesion
CREATE INDEX IF NOT EXISTS idx_snapshots_session
    ON undo_snapshots(session_id);


-- ============================================================================
-- TABLE: sessions
-- Contract ref: context-store.md (ContextStoreConfig.ttl_ms)
-- Purpose: Registra sesiones activas con su TTL para expiracion automatica.
--          El Context Store consulta esta tabla para verificar si una sesion
--          ha expirado antes de atender operaciones.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,         -- UUID de la sesion

    -- Lifecycle
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_access_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Estado
    status          TEXT NOT NULL DEFAULT 'active'  -- active | expired | destroyed
);

-- Indice para buscar sesiones por estado
CREATE INDEX IF NOT EXISTS idx_sessions_status
    ON sessions(status);


-- ============================================================================
-- TABLE: audit_events
-- Contract ref: security.md (AuditLogger, AuditEvent)
-- Purpose: Persistencia opcional de eventos de auditoria emitidos por el
--          AuditLogger. Los eventos se emiten via EventEmitter en memoria,
--          pero pueden suscribirse a esta tabla para persistencia.
--          Tipos: command:executed, command:failed, permission:denied,
--                 confirm:requested, confirm:executed, confirm:expired,
--                 session:created, session:expired, error:handler, error:timeout
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identidad del evento
    session_id      TEXT NOT NULL,            -- UUID de la sesion que genero el evento
    event_type      TEXT NOT NULL,            -- Tipo del evento (AuditEventType)

    -- Datos del evento (payload tipado segun event_type)
    data            TEXT NOT NULL DEFAULT '{}',  -- JSON: Record<string, any>

    -- Timestamp
    timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Constraints
    CONSTRAINT audit_event_type_valid CHECK (
        event_type IN (
            'command:executed', 'command:failed', 'permission:denied',
            'confirm:requested', 'confirm:executed', 'confirm:expired',
            'session:created', 'session:expired',
            'error:handler', 'error:timeout'
        )
    ),
    CONSTRAINT audit_session_nonempty CHECK (LENGTH(session_id) >= 1)
);

-- Indice para consultar eventos de una sesion
CREATE INDEX IF NOT EXISTS idx_audit_session
    ON audit_events(session_id, timestamp DESC);

-- Indice para filtrar por tipo de evento
CREATE INDEX IF NOT EXISTS idx_audit_type
    ON audit_events(event_type, timestamp DESC);

-- Indice para limpieza de eventos antiguos
CREATE INDEX IF NOT EXISTS idx_audit_timestamp
    ON audit_events(timestamp);


-- ============================================================================
-- TRIGGER: Actualizar updated_at en commands al modificar
-- Nota: En PostgreSQL se usaria una funcion trigger separada.
--       En SQLite se usa trigger directo.
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_commands_updated_at
    AFTER UPDATE ON commands
    FOR EACH ROW
BEGIN
    UPDATE commands
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_embeddings_updated_at
    AFTER UPDATE ON command_embeddings
    FOR EACH ROW
BEGIN
    UPDATE command_embeddings
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_context_updated_at
    AFTER UPDATE ON session_context
    FOR EACH ROW
BEGIN
    UPDATE session_context
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = NEW.id;
END;


-- ============================================================================
-- VIEWS: Consultas utiles pre-definidas
-- ============================================================================

-- Vista: Comandos con su estado de indexacion vectorial
CREATE VIEW IF NOT EXISTS v_commands_index_status AS
SELECT
    c.id,
    c.namespace || ':' || c.name || '@' || c.version AS full_id,
    c.description,
    CASE WHEN ce.id IS NOT NULL THEN 1 ELSE 0 END AS is_indexed,
    ce.dimensions,
    ce.model_id,
    ce.updated_at AS last_indexed_at
FROM commands c
LEFT JOIN command_embeddings ce ON ce.command_id = c.id;

-- Vista: Historial reciente con info de undo disponible
CREATE VIEW IF NOT EXISTS v_recent_history AS
SELECT
    ch.session_id,
    ch.command_id,
    ch.command_raw,
    ch.exit_code,
    ch.executed_at,
    ch.undoable,
    ch.undo_status,
    CASE WHEN us.id IS NOT NULL THEN 1 ELSE 0 END AS has_snapshot
FROM command_history ch
LEFT JOIN undo_snapshots us ON us.id = ch.snapshot_id
ORDER BY ch.executed_at DESC;


-- ============================================================================
-- NOTAS DE MIGRACION A POSTGRESQL
-- ============================================================================
--
-- Para migrar este schema a PostgreSQL, aplicar los siguientes cambios:
--
-- 1. Tipos de datos:
--    - INTEGER PRIMARY KEY AUTOINCREMENT  ->  BIGSERIAL PRIMARY KEY
--    - TEXT (para JSON)                    ->  JSONB (para params, tags, metadata, etc.)
--    - TEXT (para embedding_vector)        ->  VECTOR(N) (con pgvector extension)
--    - INTEGER (para boolean)             ->  BOOLEAN
--
-- 2. Timestamps:
--    - TEXT con strftime(...)              ->  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
--
-- 3. Triggers:
--    - Reemplazar triggers SQLite por funciones PL/pgSQL
--
-- 4. Indices:
--    - idx_embeddings_*                   ->  Agregar indice IVFFLAT o HNSW para vector search
--    - idx_commands_tags (si jsonb)       ->  CREATE INDEX ... USING GIN (tags)
--
-- 5. Extension requerida:
--    - CREATE EXTENSION IF NOT EXISTS vector;  (para pgvector)
--
-- 6. Ejemplo de columna vector en PostgreSQL:
--    - embedding_vector VECTOR(1536)  -- para OpenAI ada-002
--    - CREATE INDEX idx_emb_vector ON command_embeddings
--        USING ivfflat (embedding_vector vector_cosine_ops) WITH (lists = 100);
--
-- 7. Tabla sessions:
--    - expires_at TEXT  ->  expires_at TIMESTAMPTZ
--    - status TEXT       ->  status VARCHAR(10) con CHECK
--
-- 8. Tabla audit_events:
--    - data TEXT         ->  data JSONB
--    - timestamp TEXT    ->  timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
--    - Considerar particionamiento por mes para alto volumen
--
-- ============================================================================
