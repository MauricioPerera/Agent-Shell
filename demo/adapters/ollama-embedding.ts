/**
 * EmbeddingAdapter para Ollama local.
 * Usa el endpoint /api/embed para generar vectores.
 */

import type { EmbeddingAdapter, EmbeddingResult } from '../../src/vector-index/types.js';

export interface OllamaConfig {
  baseUrl?: string;
  model?: string;
}

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  private readonly baseUrl: string;
  private readonly model: string;
  private dimensions: number = 0;

  constructor(config: OllamaConfig = {}) {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.model = config.model || 'embeddinggemma';
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    const vector: number[] = data.embeddings[0];

    if (this.dimensions === 0) {
      this.dimensions = vector.length;
    }

    return {
      vector,
      dimensions: vector.length,
      tokenCount: text.split(/\s+/).length,
      model: this.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedBatch failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;
    const embeddings: number[][] = data.embeddings;

    if (this.dimensions === 0 && embeddings.length > 0) {
      this.dimensions = embeddings[0].length;
    }

    return embeddings.map((vector, i) => ({
      vector,
      dimensions: vector.length,
      tokenCount: texts[i].split(/\s+/).length,
      model: this.model,
    }));
  }

  getDimensions(): number {
    return this.dimensions || 768;
  }

  getModelId(): string {
    return this.model;
  }
}
