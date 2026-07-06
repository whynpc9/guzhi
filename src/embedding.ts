import type { PgliteStorage } from "./storage.js";
import type { QueuedChunk } from "./storage.js";
import type { WenguConfig } from "./types.js";
import { WenguError } from "./types.js";
import { estimateTokens } from "./tokenize.js";

export interface EmbeddingSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  remaining: number;
  dimensions: number | null;
}

export async function embedBatch(texts: string[], config: WenguConfig["embedding"]): Promise<number[][]> {
  if (config.provider === "none") return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const apiKey = process.env.WENGU_EMBEDDING__API_KEY ?? process.env.OPENAI_API_KEY;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = {
      model: config.model,
      input: texts,
    };
    if (config.request_dimensions && config.dimensions > 0) {
      body.dimensions = config.dimensions;
    }

    const response = await fetch(config.base_url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      throw new EmbeddingHttpError(
        `Embedding request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`,
        retryable,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = payload.data ?? [];
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item));
    if (vectors.length !== texts.length) {
      throw new EmbeddingHttpError(
        `Embedding response returned ${vectors.length} vectors for ${texts.length} inputs.`,
        false,
      );
    }
    return vectors;
  } catch (error) {
    if (error instanceof EmbeddingHttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new EmbeddingHttpError(`Embedding request timed out after ${config.timeout_ms}ms.`, true);
    }
    if (error instanceof Error) {
      const cause = "cause" in error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
      throw new EmbeddingHttpError(`${error.message}${cause}`, true);
    }
    throw new EmbeddingHttpError(String(error), true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function processEmbeddingQueue(
  storage: PgliteStorage,
  config: WenguConfig,
  options: { limit?: number } = {},
): Promise<EmbeddingSummary> {
  if (config.embedding.provider === "none") {
    const stats = await storage.getStats();
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      remaining: stats.queued_embeddings + stats.failed_embeddings,
      dimensions: null,
    };
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let dimensions: number | null = null;
  const max = options.limit ?? Number.POSITIVE_INFINITY;

  while (attempted < max) {
    const batchSize = Math.min(config.embedding.batch_size, max - attempted);
    const queued = await storage.listQueuedChunks(batchSize);
    if (!queued.length) break;
    const batches = buildEmbeddingBatches(queued, config);
    let processedAny = false;
    for (const batch of batches) {
      if (attempted >= max) break;
      processedAny = true;
      attempted += batch.length;
    try {
      const vectors = await embedBatch(
        batch.map((chunk) => chunk.input),
        config.embedding,
      );
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index];
        if (config.embedding.dimensions > 0 && vector.length !== config.embedding.dimensions) {
          const message = `Embedding dimension mismatch: expected ${config.embedding.dimensions}, got ${vector.length}.`;
          await storage.markEmbeddingFailure(batch[index].chunk.chunk_uid, message, false);
          failed += 1;
          continue;
        }
        dimensions = vector.length;
        await storage.fulfillEmbedding(
          batch[index].chunk.chunk_uid,
          batch[index].chunk.content_hash,
          vector,
          config.embedding,
        );
        await storage.setEmbeddingFingerprint(config.embedding, vector.length);
        succeeded += 1;
      }
    } catch (error) {
      const retryable = error instanceof EmbeddingHttpError ? error.retryable : true;
      const message = error instanceof Error ? error.message : String(error);
      for (const item of batch) {
        await storage.markEmbeddingFailure(item.chunk.chunk_uid, message, retryable);
        failed += 1;
      }
      if (!retryable) break;
    }
    }
    if (!processedAny) break;
  }

  const stats = await storage.getStats();
  return {
    attempted,
    succeeded,
    failed,
    remaining: stats.queued_embeddings + stats.failed_embeddings,
    dimensions,
  };
}

interface PreparedEmbeddingInput {
  chunk: QueuedChunk;
  input: string;
  tokenEstimate: number;
}

function buildEmbeddingBatches(
  chunks: QueuedChunk[],
  config: WenguConfig,
): PreparedEmbeddingInput[][] {
  const prepared = chunks.map((chunk) => {
    const input = truncateForEmbedding(chunk.body, config);
    return {
      chunk,
      input,
      tokenEstimate: Math.min(
        estimateTokens(input, config.chunking.cjk_char_per_token),
        config.embedding.max_input_tokens,
      ),
    };
  });

  const batches: PreparedEmbeddingInput[][] = [];
  let current: PreparedEmbeddingInput[] = [];
  let currentTokens = 0;
  for (const item of prepared) {
    const wouldExceed =
      current.length > 0 &&
      currentTokens + item.tokenEstimate > config.embedding.max_batch_tokens;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += item.tokenEstimate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function truncateForEmbedding(text: string, config: WenguConfig): string {
  if (estimateTokens(text, config.chunking.cjk_char_per_token) <= config.embedding.max_input_tokens) {
    return text;
  }
  let truncated = text;
  while (
    truncated.length > 1000 &&
    estimateTokens(truncated, config.chunking.cjk_char_per_token) > config.embedding.max_input_tokens
  ) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.8));
  }
  return `${truncated}\n\n[wengu: embedding input truncated]`;
}

export async function checkEmbeddingProvider(config: WenguConfig): Promise<{
  ok: boolean;
  dimensions?: number;
  message: string;
}> {
  if (config.embedding.provider === "none") {
    return { ok: true, message: "Embedding provider is disabled." };
  }
  try {
    const [vector] = await embedBatch(["温故"], config.embedding);
    return {
      ok: true,
      dimensions: vector.length,
      message: `Embedding provider returned ${vector.length} dimensions.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function throwIfEmbeddingConfigDrift(
  fingerprint: unknown,
  config: WenguConfig["embedding"],
): void {
  if (!fingerprint || typeof fingerprint !== "object" || config.provider === "none") return;
  const fp = fingerprint as { provider?: string; model?: string; dimensions?: number };
  if (
    fp.provider !== config.provider ||
    fp.model !== config.model ||
    (config.dimensions > 0 && fp.dimensions !== config.dimensions)
  ) {
    throw new WenguError(
      "config",
      `Embedding configuration differs from existing index fingerprint (${fp.provider}/${fp.model}/${fp.dimensions}).`,
      "Use the old embedding config or rebuild with `wengu sync --full`.",
    );
  }
}

export class EmbeddingHttpError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingHttpError";
  }
}
