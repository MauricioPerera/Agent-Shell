/**
 * minimemory API Adapter for Agent Shell.
 *
 * Provides typed access to the minimemory Rust library via its Node.js
 * napi-rs binding. Exposes VectorDB, AgentMemory, and hybrid search
 * capabilities for use as handler logic in Agent Shell commands.
 *
 * Unlike HTTP-based adapters (VoltAgent, n8n, LangGraph), this adapter
 * calls the native binding directly - no network, no server required.
 *
 * @see https://github.com/MauricioPerera/minimemory
 */

// --- Types ---

export interface MiniMemoryConfig {
  /** Vector dimensions (must match embedding model) */
  dimensions: number;
  /** Distance metric */
  distance?: 'cosine' | 'euclidean' | 'dot_product';
  /** Index type */
  indexType?: 'flat' | 'hnsw';
  /** Quantization type */
  quantization?: 'none' | 'int8' | 'binary';
  /** Full-text search fields */
  fulltextFields?: string[];
  /** File path for persistence */
  persistPath?: string;
}

export interface MiniMemorySearchResult {
  id: string;
  distance: number;
  score: number;
  metadata?: Record<string, any>;
}

export interface MiniMemoryHybridParams {
  vector?: number[];
  keywords?: string;
  filter?: Record<string, any>;
  topK: number;
  vectorWeight?: number;
  fusionK?: number;
}

export interface MiniMemoryInsertParams {
  id: string;
  vector?: number[];
  metadata?: Record<string, any>;
  content?: string;
}

export interface MiniMemoryFilterParams {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'starts_with';
  value: any;
}

export interface MiniMemoryStats {
  count: number;
  dimensions: number;
  distance: string;
  indexType: string;
  hasFulltext: boolean;
  quantization: string;
}

// --- Agent Memory Types ---

export interface TaskEpisode {
  task: string;
  solution: string;
  outcome: 'success' | 'failure' | 'partial';
  learnings: string[];
}

export interface CodeSnippet {
  code: string;
  description: string;
  language: string;
  dependencies: string[];
  useCase: string;
  qualityScore: number;
  tags: string[];
}

export interface ErrorSolution {
  errorMessage: string;
  errorType: string;
  rootCause: string;
  solution: string;
  fixedCode?: string;
  language: string;
}

export interface AgentMemoryStats {
  totalEntries: number;
  episodes: number;
  codeSnippets: number;
  errorSolutions: number;
}

export interface RecallResult {
  id: string;
  relevance: number;
  priority?: string;
  transferLevel?: string;
  content: Record<string, any>;
}

// --- Adapter Class ---

export class MiniMemoryApiAdapter {
  private db: any;
  private agentMemory: any;
  private config: MiniMemoryConfig;
  private VectorDB: any;
  private AgentMemory: any;

  constructor(config: MiniMemoryConfig, binding?: { VectorDB: any; AgentMemory?: any }) {
    this.config = config;

    if (binding) {
      this.VectorDB = binding.VectorDB;
      this.AgentMemory = binding.AgentMemory;
    } else {
      try {
        const mm = require('minimemory');
        this.VectorDB = mm.VectorDB;
        this.AgentMemory = mm.AgentMemory;
      } catch {
        throw new Error(
          'minimemory Node.js binding not found. Install with: npm install minimemory ' +
          '(or build from source: https://github.com/MauricioPerera/minimemory)'
        );
      }
    }

    this.initDb();
    this.initAgentMemory();
  }

  private initDb(): void {
    const dbConfig: Record<string, any> = {
      dimensions: this.config.dimensions,
      distance: this.config.distance || 'cosine',
      index_type: this.config.indexType || 'hnsw',
    };

    if (this.config.quantization && this.config.quantization !== 'none') {
      dbConfig.quantization = this.config.quantization;
    }

    if (this.config.fulltextFields && this.config.fulltextFields.length > 0) {
      this.db = this.VectorDB.withFulltext(dbConfig, this.config.fulltextFields);
    } else {
      this.db = new this.VectorDB(dbConfig);
    }

    if (this.config.persistPath) {
      try {
        this.db.load(this.config.persistPath);
      } catch {
        // Fresh database
      }
    }
  }

  private initAgentMemory(): void {
    try {
      const memConfig = this.config.dimensions <= 384
        ? { type: 'small' }
        : { type: 'openai', dimensions: this.config.dimensions };
      this.agentMemory = new this.AgentMemory(memConfig);
    } catch {
      // AgentMemory may not be available in all binding versions
      this.agentMemory = null;
    }
  }

  // === VectorDB Operations ===

  /** Insert a document with optional vector and metadata */
  insert(params: MiniMemoryInsertParams): void {
    if (params.vector) {
      this.db.insert(params.id, params.vector, params.metadata || {});
    } else {
      this.db.insert_document(params.id, null, params.metadata || {});
    }
  }

  /** Update an existing document */
  update(id: string, vector?: number[], metadata?: Record<string, any>): void {
    this.db.update_document(id, vector || null, metadata || null);
  }

  /** Delete a document by ID */
  delete(id: string): void {
    this.db.delete(id);
  }

  /** Check if a document exists */
  contains(id: string): boolean {
    return this.db.contains(id);
  }

  /** Get a document by ID */
  get(id: string): { vector: number[] | null; metadata: Record<string, any> } | null {
    try {
      return this.db.get(id);
    } catch {
      return null;
    }
  }

  /** Vector similarity search */
  search(vector: number[], topK: number): MiniMemorySearchResult[] {
    const results = this.db.search(vector, topK);
    return results.map((r: any) => ({
      id: r.id,
      distance: r.distance,
      score: 1 - r.distance,
      metadata: r.metadata,
    }));
  }

  /** BM25 keyword search */
  keywordSearch(query: string, topK: number): MiniMemorySearchResult[] {
    const results = this.db.keyword_search(query, topK);
    return results.map((r: any) => ({
      id: r.id,
      distance: r.distance || 0,
      score: r.score || (1 - (r.distance || 0)),
      metadata: r.metadata,
    }));
  }

  /** Hybrid search: vector + keywords + metadata filters */
  hybridSearch(params: MiniMemoryHybridParams): MiniMemorySearchResult[] {
    const searchParams: Record<string, any> = {
      top_k: params.topK,
    };

    if (params.vector) searchParams.vector = params.vector;
    if (params.keywords) searchParams.keywords = params.keywords;
    if (params.filter) searchParams.filter = params.filter;
    if (params.vectorWeight !== undefined) searchParams.vector_weight = params.vectorWeight;
    if (params.fusionK !== undefined) searchParams.fusion_k = params.fusionK;

    const results = this.db.hybrid_search(searchParams);
    return results.map((r: any) => ({
      id: r.id,
      distance: r.distance || 0,
      score: r.score || (1 - (r.distance || 0)),
      metadata: r.metadata,
    }));
  }

  /** Filter-only search (metadata) */
  filterSearch(filters: MiniMemoryFilterParams[], topK: number): MiniMemorySearchResult[] {
    const filterObj = this.buildFilter(filters);
    const results = this.db.filter_search(filterObj, topK);
    return results.map((r: any) => ({
      id: r.id,
      distance: 0,
      score: 1,
      metadata: r.metadata,
    }));
  }

  /** Get database statistics */
  stats(): MiniMemoryStats {
    return {
      count: this.db.len(),
      dimensions: this.config.dimensions,
      distance: this.config.distance || 'cosine',
      indexType: this.config.indexType || 'hnsw',
      hasFulltext: this.db.has_fulltext?.() || false,
      quantization: this.config.quantization || 'none',
    };
  }

  /** Persist database to disk */
  save(path?: string): void {
    const savePath = path || this.config.persistPath;
    if (!savePath) throw new Error('No persist path configured');
    this.db.save(savePath);
  }

  /** Load database from disk */
  load(path?: string): void {
    const loadPath = path || this.config.persistPath;
    if (!loadPath) throw new Error('No persist path configured');
    this.db.load(loadPath);
  }

  // === Agent Memory Operations ===

  /** Learn from a completed task */
  learnTask(episode: TaskEpisode): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.learn_task(
      episode.task,
      episode.solution,
      episode.outcome,
      episode.learnings,
    );
  }

  /** Learn a code snippet */
  learnCode(snippet: CodeSnippet): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.learn_code({
      code: snippet.code,
      description: snippet.description,
      language: snippet.language,
      dependencies: snippet.dependencies,
      use_case: snippet.useCase,
      quality_score: snippet.qualityScore,
      tags: snippet.tags,
    });
  }

  /** Learn an error solution */
  learnError(solution: ErrorSolution): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.learn_error_solution({
      error_message: solution.errorMessage,
      error_type: solution.errorType,
      root_cause: solution.rootCause,
      solution: solution.solution,
      fixed_code: solution.fixedCode || null,
      language: solution.language,
    });
  }

  /** Recall similar experiences */
  recallSimilar(query: string, topK: number): RecallResult[] {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    const results = this.agentMemory.recall_similar(query, topK);
    return this.mapRecallResults(results);
  }

  /** Recall code snippets */
  recallCode(query: string, topK: number): RecallResult[] {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    const results = this.agentMemory.recall_code(query, topK);
    return this.mapRecallResults(results);
  }

  /** Recall error solutions */
  recallErrors(query: string, topK: number): RecallResult[] {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    const results = this.agentMemory.recall_error_solutions(query, topK);
    return this.mapRecallResults(results);
  }

  /** Recall only successful experiences */
  recallSuccessful(query: string, topK: number): RecallResult[] {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    const results = this.agentMemory.recall_successful(query, topK);
    return this.mapRecallResults(results);
  }

  /** Set working context */
  setWorkingContext(project: string, task?: string, goals?: string[]): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.with_working_context((ctx: any) => {
      ctx.set_project(project);
      if (task) ctx.set_task(task);
      if (goals) {
        for (const goal of goals) ctx.add_goal(goal);
      }
    });
  }

  /** Get working context */
  getWorkingContext(): Record<string, any> {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    return this.agentMemory.working_context();
  }

  /** Get agent memory statistics */
  agentMemoryStats(): AgentMemoryStats {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    const stats = this.agentMemory.stats();
    return {
      totalEntries: stats.total_entries || 0,
      episodes: stats.episodes || 0,
      codeSnippets: stats.code_snippets || 0,
      errorSolutions: stats.error_solutions || 0,
    };
  }

  /** Save agent memory to disk */
  saveMemory(path: string): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.save(path);
  }

  /** Load agent memory from disk */
  loadMemory(path: string): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.load(path);
  }

  /** Focus on a specific project (uses partial index) */
  focusProject(project: string): void {
    if (!this.agentMemory) throw new Error('AgentMemory not available in this binding version');
    this.agentMemory.focus_project(project);
  }

  // === Helpers ===

  private buildFilter(filters: MiniMemoryFilterParams[]): Record<string, any> {
    if (filters.length === 0) return {};
    if (filters.length === 1) {
      const f = filters[0];
      return { [f.operator]: { field: f.field, value: f.value } };
    }
    // Combine with AND
    return {
      and: filters.map(f => ({ [f.operator]: { field: f.field, value: f.value } })),
    };
  }

  private mapRecallResults(results: any[]): RecallResult[] {
    return (results || []).map((r: any) => ({
      id: r.id,
      relevance: r.relevance || r.score || 0,
      priority: r.priority,
      transferLevel: r.transfer_level,
      content: r.content || r.metadata || {},
    }));
  }
}
