/**
 * VoltAgent API Adapter for Agent Shell.
 *
 * Provides typed access to the VoltAgent HTTP API for managing
 * agents, conversations, workflows, and memory. Designed for use
 * as handler logic in Agent Shell commands.
 *
 * @see https://github.com/MauricioPerera/voltagent
 */

export interface VoltAgentConfig {
  /** VoltAgent server base URL (e.g. http://localhost:3141) */
  baseUrl: string;
  /** Optional API key for authentication */
  apiKey?: string;
}

export interface VoltAgentInfo {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string;
  tools?: Array<{ name: string; description?: string }>;
  subAgents?: string[];
}

export interface VoltAgentConversation {
  id: string;
  agentId: string;
  title?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface VoltAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  conversationId: string;
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface VoltAgentTextRequest {
  input: string;
  conversationId?: string;
  userId?: string;
  contextMessages?: Array<{ role: string; content: string }>;
  metadata?: Record<string, any>;
}

export interface VoltAgentTextResponse {
  text: string;
  conversationId?: string;
  metadata?: Record<string, any>;
}

export interface VoltAgentWorkflow {
  id: string;
  name: string;
  description?: string;
  steps?: string[];
}

export interface VoltAgentWorkflowExecution {
  executionId: string;
  workflowId: string;
  status: 'running' | 'completed' | 'suspended' | 'cancelled' | 'failed';
  result?: any;
  error?: string;
}

export interface VoltAgentStreamEvent {
  event: string;
  data: any;
}

export class VoltAgentApiAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: VoltAgentConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  /** List all registered agents */
  async listAgents(): Promise<VoltAgentInfo[]> {
    const response = await fetch(`${this.baseUrl}/agents`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentInfo[];
  }

  /** Send a message to an agent and get a text response */
  async generateText(agentId: string, request: VoltAgentTextRequest): Promise<VoltAgentTextResponse> {
    const response = await fetch(`${this.baseUrl}/agents/${agentId}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentTextResponse;
  }

  /** Send a message to an agent with SSE streaming */
  async streamText(
    agentId: string,
    request: VoltAgentTextRequest,
    onEvent: (event: VoltAgentStreamEvent) => void
  ): Promise<{ events_count: number; final_text: string }> {
    const response = await fetch(`${this.baseUrl}/agents/${agentId}/stream`, {
      method: 'POST',
      headers: { ...this.headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let eventsCount = 0;
    let finalText = '';

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
            if (data.text) finalText = data.text;
            if (data.textDelta) finalText += data.textDelta;
          } catch {
            // Non-JSON data line - accumulate as text
            const raw = line.slice(6);
            if (raw) finalText += raw;
          }
        }
      }
    }

    return { events_count: eventsCount, final_text: finalText };
  }

  /** Chat with an agent (streaming conversation) */
  async chat(
    agentId: string,
    request: VoltAgentTextRequest,
    onEvent: (event: VoltAgentStreamEvent) => void
  ): Promise<{ events_count: number; final_text: string; conversationId?: string }> {
    const response = await fetch(`${this.baseUrl}/agents/${agentId}/chat`, {
      method: 'POST',
      headers: { ...this.headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let eventsCount = 0;
    let finalText = '';
    let conversationId: string | undefined;

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
            if (data.text) finalText = data.text;
            if (data.textDelta) finalText += data.textDelta;
            if (data.conversationId) conversationId = data.conversationId;
          } catch {
            const raw = line.slice(6);
            if (raw) finalText += raw;
          }
        }
      }
    }

    return { events_count: eventsCount, final_text: finalText, conversationId };
  }

  /** Generate a structured object from an agent */
  async generateObject(agentId: string, request: VoltAgentTextRequest & { schema?: Record<string, any> }): Promise<any> {
    const response = await fetch(`${this.baseUrl}/agents/${agentId}/object`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json();
  }

  /** List all registered workflows */
  async listWorkflows(): Promise<VoltAgentWorkflow[]> {
    const response = await fetch(`${this.baseUrl}/workflows`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentWorkflow[];
  }

  /** Execute a workflow and wait for result */
  async executeWorkflow(workflowId: string, input: Record<string, any>): Promise<VoltAgentWorkflowExecution> {
    const response = await fetch(`${this.baseUrl}/workflows/${workflowId}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentWorkflowExecution;
  }

  /** Execute a workflow with SSE streaming */
  async streamWorkflow(
    workflowId: string,
    input: Record<string, any>,
    onEvent: (event: VoltAgentStreamEvent) => void
  ): Promise<{ events_count: number; final_result: any }> {
    const response = await fetch(`${this.baseUrl}/workflows/${workflowId}/stream`, {
      method: 'POST',
      headers: { ...this.headers, 'Accept': 'text/event-stream' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';
    let eventsCount = 0;
    let finalResult: any = null;

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
            finalResult = data;
          } catch {
            // Skip non-JSON
          }
        }
      }
    }

    return { events_count: eventsCount, final_result: finalResult };
  }

  /** Resume a suspended workflow execution */
  async resumeWorkflow(workflowId: string, executionId: string, input?: Record<string, any>): Promise<VoltAgentWorkflowExecution> {
    const response = await fetch(`${this.baseUrl}/workflows/${workflowId}/executions/${executionId}/resume`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(input || {}),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentWorkflowExecution;
  }

  /** Cancel a running workflow execution */
  async cancelWorkflow(workflowId: string, executionId: string, reason?: string): Promise<VoltAgentWorkflowExecution> {
    const response = await fetch(`${this.baseUrl}/workflows/${workflowId}/executions/${executionId}/cancel`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ reason }),
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentWorkflowExecution;
  }

  /** List conversations for an agent */
  async listConversations(agentId: string, options?: { limit?: number; offset?: number }): Promise<VoltAgentConversation[]> {
    const params = new URLSearchParams({ agentId });
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const response = await fetch(`${this.baseUrl}/api/memory/conversations?${params}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentConversation[];
  }

  /** Get messages from a conversation */
  async listMessages(conversationId: string, agentId: string, options?: { limit?: number }): Promise<VoltAgentMessage[]> {
    const params = new URLSearchParams({ agentId });
    if (options?.limit) params.set('limit', String(options.limit));

    const response = await fetch(`${this.baseUrl}/api/memory/conversations/${conversationId}/messages?${params}`, {
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`VoltAgent API error ${response.status}: ${await response.text()}`);
    }

    return await response.json() as VoltAgentMessage[];
  }

  /** Health check - verify VoltAgent server is reachable */
  async healthCheck(): Promise<{ status: string; url: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/`, {
        headers: { 'Accept': 'text/html' },
      });
      if (response.ok) {
        return { status: 'healthy', url: this.baseUrl };
      }
      return { status: 'unhealthy', url: this.baseUrl };
    } catch {
      return { status: 'unreachable', url: this.baseUrl };
    }
  }
}
