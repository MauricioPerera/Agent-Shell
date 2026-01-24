/**
 * EmbeddingAdapter para Cloudflare Workers AI.
 * Usa el endpoint REST de Workers AI para generar vectores con embeddinggemma-300m.
 */

import type { EmbeddingAdapter, EmbeddingResult } from '../../src/vector-index/types.js';

export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
  model?: string;
}

export class CloudflareEmbeddingAdapter implements EmbeddingAdapter {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly model: string;

  constructor(config: CloudflareConfig) {
    this.accountId = config.accountId;
    this.apiToken = config.apiToken;
    this.model = config.model || '@cf/google/embeddinggemma-300m';
  }

  private get endpoint(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: [text] }),
    });

    if (!response.ok) {
      throw new Error(`Cloudflare embed failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as any;
    if (!json.success) {
      throw new Error(`Cloudflare embed error: ${JSON.stringify(json.errors)}`);
    }

    const vector: number[] = json.result.data[0];

    return {
      vector,
      dimensions: vector.length,
      tokenCount: text.split(/\s+/).length,
      model: this.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: texts }),
    });

    if (!response.ok) {
      throw new Error(`Cloudflare embedBatch failed: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as any;
    if (!json.success) {
      throw new Error(`Cloudflare embedBatch error: ${JSON.stringify(json.errors)}`);
    }

    const embeddings: number[][] = json.result.data;

    return embeddings.map((vector, i) => ({
      vector,
      dimensions: vector.length,
      tokenCount: texts[i].split(/\s+/).length,
      model: this.model,
    }));
  }

  getDimensions(): number {
    return 768;
  }

  getModelId(): string {
    return this.model;
  }
}
