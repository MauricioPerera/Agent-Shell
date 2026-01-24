/**
 * Comandos de demo para Agent Shell.
 * CRUD de usuarios y notas en memoria.
 */

// --- In-memory data stores ---
const users: Map<number, { id: number; name: string; email: string; role: string; created_at: string }> = new Map();
const notes: Map<number, { id: number; title: string; content: string; author: string; created_at: string }> = new Map();
let nextUserId = 1;
let nextNoteId = 1;

// --- Command definitions ---
export const demoCommands = [
  // === Users namespace ===
  {
    namespace: 'users',
    name: 'create',
    version: '1.0.0',
    description: 'Crea un nuevo usuario en el sistema',
    params: [
      { name: 'name', type: 'string', required: true, description: 'Nombre completo del usuario' },
      { name: 'email', type: 'string', required: true, description: 'Email del usuario' },
      { name: 'role', type: 'enum', enumValues: ['admin', 'editor', 'viewer'], default: 'viewer', description: 'Rol del usuario' },
    ],
    tags: ['user', 'creation', 'crud'],
    example: 'users:create --name "Juan Perez" --email juan@ejemplo.com --role admin',
    handler: async (args: any) => {
      const id = nextUserId++;
      const user = { id, name: args.name, email: args.email, role: args.role || 'viewer', created_at: new Date().toISOString() };
      users.set(id, user);
      return { success: true, data: user };
    },
    undoable: true,
  },
  {
    namespace: 'users',
    name: 'list',
    version: '1.0.0',
    description: 'Lista todos los usuarios registrados en el sistema',
    params: [
      { name: 'role', type: 'string', description: 'Filtrar por rol' },
    ],
    tags: ['user', 'listing', 'crud'],
    example: 'users:list --role admin',
    handler: async (args: any) => {
      let result = Array.from(users.values());
      if (args.role) result = result.filter(u => u.role === args.role);
      return { success: true, data: result };
    },
    undoable: false,
  },
  {
    namespace: 'users',
    name: 'get',
    version: '1.0.0',
    description: 'Obtiene los detalles de un usuario por su ID',
    params: [
      { name: 'id', type: 'int', required: true, description: 'ID del usuario' },
    ],
    tags: ['user', 'detail', 'crud'],
    example: 'users:get --id 1',
    handler: async (args: any) => {
      const user = users.get(Number(args.id));
      if (!user) return { success: false, data: null, error: 'Usuario no encontrado' };
      return { success: true, data: user };
    },
    undoable: false,
  },
  {
    namespace: 'users',
    name: 'update',
    version: '1.0.0',
    description: 'Actualiza los datos de un usuario existente',
    params: [
      { name: 'id', type: 'int', required: true, description: 'ID del usuario' },
      { name: 'name', type: 'string', description: 'Nuevo nombre' },
      { name: 'email', type: 'string', description: 'Nuevo email' },
      { name: 'role', type: 'enum', enumValues: ['admin', 'editor', 'viewer'], description: 'Nuevo rol' },
    ],
    tags: ['user', 'update', 'crud'],
    example: 'users:update --id 1 --role admin',
    handler: async (args: any) => {
      const user = users.get(Number(args.id));
      if (!user) return { success: false, data: null, error: 'Usuario no encontrado' };
      if (args.name) user.name = args.name;
      if (args.email) user.email = args.email;
      if (args.role) user.role = args.role;
      return { success: true, data: user };
    },
    undoable: true,
  },
  {
    namespace: 'users',
    name: 'delete',
    version: '1.0.0',
    description: 'Elimina un usuario del sistema permanentemente',
    params: [
      { name: 'id', type: 'int', required: true, description: 'ID del usuario a eliminar' },
    ],
    tags: ['user', 'deletion', 'crud', 'destructive'],
    example: 'users:delete --id 1',
    handler: async (args: any) => {
      const id = Number(args.id);
      const existed = users.has(id);
      users.delete(id);
      return { success: true, data: { deleted: existed, id } };
    },
    confirm: true,
    undoable: false,
  },
  {
    namespace: 'users',
    name: 'count',
    version: '1.0.0',
    description: 'Retorna la cantidad total de usuarios registrados',
    params: [],
    tags: ['user', 'stats', 'count'],
    example: 'users:count',
    handler: async () => {
      return { success: true, data: { count: users.size } };
    },
    undoable: false,
  },

  // === Notes namespace ===
  {
    namespace: 'notes',
    name: 'create',
    version: '1.0.0',
    description: 'Crea una nueva nota o apunte',
    params: [
      { name: 'title', type: 'string', required: true, description: 'Titulo de la nota' },
      { name: 'content', type: 'string', required: true, description: 'Contenido de la nota' },
      { name: 'author', type: 'string', default: 'anonymous', description: 'Autor de la nota' },
    ],
    tags: ['notes', 'creation', 'writing'],
    example: 'notes:create --title "Mi nota" --content "Contenido importante"',
    handler: async (args: any) => {
      const id = nextNoteId++;
      const note = { id, title: args.title, content: args.content, author: args.author || 'anonymous', created_at: new Date().toISOString() };
      notes.set(id, note);
      return { success: true, data: note };
    },
    undoable: true,
  },
  {
    namespace: 'notes',
    name: 'list',
    version: '1.0.0',
    description: 'Lista todas las notas existentes',
    params: [
      { name: 'author', type: 'string', description: 'Filtrar por autor' },
    ],
    tags: ['notes', 'listing'],
    example: 'notes:list --author juan',
    handler: async (args: any) => {
      let result = Array.from(notes.values());
      if (args.author) result = result.filter(n => n.author === args.author);
      return { success: true, data: result };
    },
    undoable: false,
  },
  {
    namespace: 'notes',
    name: 'get',
    version: '1.0.0',
    description: 'Obtiene el contenido completo de una nota por su ID',
    params: [
      { name: 'id', type: 'int', required: true, description: 'ID de la nota' },
    ],
    tags: ['notes', 'detail', 'reading'],
    example: 'notes:get --id 1',
    handler: async (args: any) => {
      const note = notes.get(Number(args.id));
      if (!note) return { success: false, data: null, error: 'Nota no encontrada' };
      return { success: true, data: note };
    },
    undoable: false,
  },
  {
    namespace: 'notes',
    name: 'delete',
    version: '1.0.0',
    description: 'Elimina una nota permanentemente',
    params: [
      { name: 'id', type: 'int', required: true, description: 'ID de la nota a eliminar' },
    ],
    tags: ['notes', 'deletion', 'destructive'],
    example: 'notes:delete --id 1',
    handler: async (args: any) => {
      const id = Number(args.id);
      notes.delete(id);
      return { success: true, data: { deleted: true, id } };
    },
    undoable: false,
  },
  {
    namespace: 'notes',
    name: 'search',
    version: '1.0.0',
    description: 'Busca notas que contengan un texto en titulo o contenido',
    params: [
      { name: 'query', type: 'string', required: true, description: 'Texto a buscar' },
    ],
    tags: ['notes', 'search', 'filtering'],
    example: 'notes:search --query "importante"',
    handler: async (args: any) => {
      const q = (args.query || '').toLowerCase();
      const result = Array.from(notes.values()).filter(
        n => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
      );
      return { success: true, data: result };
    },
    undoable: false,
  },

  // === System namespace ===
  {
    namespace: 'system',
    name: 'status',
    version: '1.0.0',
    description: 'Muestra el estado actual del sistema y estadisticas',
    params: [],
    tags: ['system', 'status', 'monitoring'],
    example: 'system:status',
    handler: async () => {
      return {
        success: true,
        data: {
          uptime: process.uptime(),
          users_count: users.size,
          notes_count: notes.size,
          memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          timestamp: new Date().toISOString(),
        },
      };
    },
    undoable: false,
  },
  {
    namespace: 'system',
    name: 'echo',
    version: '1.0.0',
    description: 'Repite el mensaje recibido (util para testing)',
    params: [
      { name: 'message', type: 'string', required: true, description: 'Mensaje a repetir' },
    ],
    tags: ['system', 'testing', 'debug'],
    example: 'system:echo --message "hola mundo"',
    handler: async (args: any) => {
      return { success: true, data: { echo: args.message } };
    },
    undoable: false,
  },
  {
    namespace: 'math',
    name: 'calc',
    version: '1.0.0',
    description: 'Realiza operaciones matematicas basicas entre dos numeros',
    params: [
      { name: 'a', type: 'float', required: true, description: 'Primer operando' },
      { name: 'b', type: 'float', required: true, description: 'Segundo operando' },
      { name: 'op', type: 'enum', enumValues: ['add', 'sub', 'mul', 'div'], required: true, description: 'Operacion: add, sub, mul, div' },
    ],
    tags: ['math', 'calculation', 'arithmetic'],
    example: 'math:calc --a 10 --b 3 --op add',
    handler: async (args: any) => {
      const a = Number(args.a);
      const b = Number(args.b);
      let result: number;
      switch (args.op) {
        case 'add': result = a + b; break;
        case 'sub': result = a - b; break;
        case 'mul': result = a * b; break;
        case 'div': result = b !== 0 ? a / b : NaN; break;
        default: return { success: false, data: null, error: `Operacion invalida: ${args.op}` };
      }
      return { success: true, data: { a, b, op: args.op, result } };
    },
    undoable: false,
  },
];
