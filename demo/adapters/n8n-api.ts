/**
 * n8n API Adapter for Agent Shell.
 *
 * Provides typed access to the n8n REST API v1 for workflow management
 * and execution. Designed for use as handler logic in Agent Shell commands.
 *
 * @see https://docs.n8n.io/api/
 */

export interface N8nConfig {
  /** n8n instance base URL (e.g. http://localhost:5678) */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  tags?: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface N8nExecution {
  id: string;
  finished: boolean;
  mode: string;
  status: string;
  startedAt: string;
  stoppedAt?: string;
  workflowId: string;
  data?: any;
}

export interface N8nWorkflowDetail extends N8nWorkflow {
  nodes: { type: string; name: string; position: [number, number] }[];
  connections: Record<string, any>;
}

export class N8nApiAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: N8nConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'X-N8N-API-KEY': config.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  /** List all workflows with optional filtering */
  async listWorkflows(options?: { active?: boolean; tags?: string }): Promise<N8nWorkflow[]> {
    const params = new URLSearchParams();
    if (options?.active !== undefined) params.set('active', String(options.active));
    if (options?.tags) params.set('tags', options.tags);

    const query = params.toString();
    const url = `${this.baseUrl}/api/v1/workflows${query ? `?${query}` : ''}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as any;
    return body.data || body;
  }

  /** Get workflow details by ID */
  async getWorkflow(id: string): Promise<N8nWorkflowDetail> {
    const response = await fetch(`${this.baseUrl}/api/v1/workflows/${id}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as N8nWorkflowDetail;
  }

  /** Execute a workflow by ID with optional payload */
  async executeWorkflow(id: string, payload?: Record<string, any>): Promise<N8nExecution> {
    const response = await fetch(`${this.baseUrl}/api/v1/workflows/${id}/run`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(payload || {}),
    });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as N8nExecution;
  }

  /** Activate a workflow */
  async activateWorkflow(id: string): Promise<N8nWorkflow> {
    const response = await fetch(`${this.baseUrl}/api/v1/workflows/${id}/activate`, {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as N8nWorkflow;
  }

  /** Deactivate a workflow */
  async deactivateWorkflow(id: string): Promise<N8nWorkflow> {
    const response = await fetch(`${this.baseUrl}/api/v1/workflows/${id}/deactivate`, {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as N8nWorkflow;
  }

  /** Get executions for a workflow */
  async getExecutions(workflowId?: string, options?: { limit?: number; status?: string }): Promise<N8nExecution[]> {
    const params = new URLSearchParams();
    if (workflowId) params.set('workflowId', workflowId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.status) params.set('status', options.status);

    const query = params.toString();
    const url = `${this.baseUrl}/api/v1/executions${query ? `?${query}` : ''}`;
    const response = await fetch(url, { headers: this.headers });

    if (!response.ok) {
      throw new Error(`n8n API error ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as any;
    return body.data || body;
  }

  /** Health check - verify n8n is reachable */
  async healthCheck(): Promise<{ status: string; version?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, {
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
