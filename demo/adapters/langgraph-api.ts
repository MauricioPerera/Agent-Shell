/**
 * LangGraph API Adapter for Agent Shell.
 *
 * Provides typed access to the LangGraph REST API for managing
 * assistants, threads, runs, and state. Designed for use as handler
 * logic in Agent Shell commands.
 *
 * @see https://langchain-ai.github.io/langgraph/cloud/reference/api/
 */

export interface LangGraphConfig {
  /** LangGraph server base URL (e.g. http://localhost:8123) */
  baseUrl: string;
  /** Optional API key for authentication */
  apiKey?: string;
}

export interface LangGraphAssistant {
  assistant_id: string;
  graph_id: string;
  name: string;
  config: Record<string, any>;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface LangGraphThread {
  thread_id: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  status: 'idle' | 'busy' | 'interrupted' | 'error';
}

export interface LangGraphRun {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  status: 'pending' | 'running' | 'error' | 'success' | 'timeout' | 'interrupted';
  created_at: string;
  updated_at: string;
  metadata: Record<string, any>;
}

export interface LangGraphRunInput {
  input: Record<string, any>;
  config?: Record<string, any>;
  metadata?: Record<string, any>;
  stream_mode?: 'values' | 'updates' | 'events';
}

export interface LangGraphState {
  values: Record<string, any>;
  next: string[];
  metadata: Record<string, any>;
  checkpoint: { thread_id: string; checkpoint_id: string } | null;
}

export interface LangGraphStreamEvent {
  event: string;
  data: any;
}

export class LangGraphApiAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: LangGraphConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (config.apiKey) {
      this.headers['X-Api-Key'] = config.apiKey;
    }
  }

  /** List/search available assistants (graphs) */
  async listAssistants(options?: { graph_id?: string; limit?: number }): Promise<LangGraphAssistant[]> {
    const body: Record<string, any> = {};
    if (options?.graph_id) body.graph_id = options.graph_id;
    if (options?.limit) body.limit = options.limit;

    const response = await fetch(`${this.baseUrl}/assistants/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphAssistant[];
  }

  /** Get assistant details by ID */
  async getAssistant(assistantId: string): Promise<LangGraphAssistant> {
    const response = await fetch(`${this.baseUrl}/assistants/${assistantId}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphAssistant;
  }

  /** Create a new thread for stateful execution */
  async createThread(metadata?: Record<string, any>): Promise<LangGraphThread> {
    const body: Record<string, any> = {};
    if (metadata) body.metadata = metadata;

    const response = await fetch(`${this.baseUrl}/threads`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphThread;
  }

  /** Get thread by ID */
  async getThread(threadId: string): Promise<LangGraphThread> {
    const response = await fetch(`${this.baseUrl}/threads/${threadId}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphThread;
  }

  /** Get current state of a thread */
  async getThreadState(threadId: string): Promise<LangGraphState> {
    const response = await fetch(`${this.baseUrl}/threads/${threadId}/state`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphState;
  }

  /** Execute a run and wait for completion */
  async createRun(threadId: string, input: LangGraphRunInput): Promise<Record<string, any>> {
    const response = await fetch(`${this.baseUrl}/threads/${threadId}/runs/wait`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        assistant_id: input.config?.configurable?.assistant_id || input.metadata?.assistant_id,
        input: input.input,
        config: input.config,
        metadata: input.metadata,
      }),
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as Record<string, any>;
  }

  /** Execute a run with SSE streaming */
  async streamRun(
    threadId: string,
    input: LangGraphRunInput,
    onEvent: (event: LangGraphStreamEvent) => void
  ): Promise<{ events_count: number; final_event: any }> {
    const response = await fetch(`${this.baseUrl}/threads/${threadId}/runs/stream`, {
      method: 'POST',
      headers: { ...this.headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        assistant_id: input.config?.configurable?.assistant_id || input.metadata?.assistant_id,
        input: input.input,
        config: input.config,
        metadata: input.metadata,
        stream_mode: input.stream_mode || 'values',
      }),
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let eventsCount = 0;
    let finalEvent: any = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            const event = { event: currentEvent, data };
            onEvent(event);
            eventsCount++;
            finalEvent = data;
          } catch {
            // Skip non-JSON data lines
          }
        }
      }
    }

    return { events_count: eventsCount, final_event: finalEvent };
  }

  /** Get run status by ID */
  async getRun(threadId: string, runId: string): Promise<LangGraphRun> {
    const response = await fetch(`${this.baseUrl}/threads/${threadId}/runs/${runId}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphRun;
  }

  /** List runs for a thread */
  async listRuns(threadId: string, options?: { limit?: number; status?: string }): Promise<LangGraphRun[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.status) params.set('status', options.status);

    const query = params.toString();
    const url = `${this.baseUrl}/threads/${threadId}/runs${query ? `?${query}` : ''}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`LangGraph API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as LangGraphRun[];
  }

  /** Health check - verify LangGraph server is reachable */
  async healthCheck(): Promise<{ status: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/ok`, {
        headers: { 'Accept': 'application/json' },
      });
      if (response.ok) {
        return { status: 'healthy' };
      }
      return { status: 'unhealthy' };
    } catch {
      return { status: 'unreachable' };
    }
  }
}
