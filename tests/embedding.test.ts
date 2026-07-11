import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { processEmbeddingQueue } from "../src/embedding.js";
import type { Stats, StorageAdapter } from "../src/storage.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("processEmbeddingQueue", () => {
  it("leaves retryable failures queued for a later invocation instead of looping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-embedding-"));
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        embeddingProvider: "openai-compatible",
      });
      const queued = {
        chunk_uid: "chunk-1",
        content_hash: "hash-1",
        body: "alpha",
        token_est: 1,
      };
      const listQueuedChunks = vi.fn(async () => [queued]);
      const markEmbeddingFailure = vi.fn(async () => undefined);
      const storage = {
        listQueuedChunks,
        markEmbeddingFailure,
        getStats: async () => statsWithOneFailedEmbedding(),
      } as unknown as StorageAdapter;

      const summary = await processEmbeddingQueue(storage, loaded.config);

      expect(listQueuedChunks).toHaveBeenCalledTimes(1);
      expect(markEmbeddingFailure).toHaveBeenCalledWith("chunk-1", expect.any(String), true);
      expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1, remaining: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function statsWithOneFailedEmbedding(): Stats {
  return {
    documents_active: 1,
    documents_deleted: 0,
    chunks: 1,
    links: 0,
    broken_links: 0,
    ambiguous_links: 0,
    queued_embeddings: 0,
    failed_embeddings: 1,
    embedded_chunks: 0,
    retrieval_mode: "keyword_only",
    last_sync: null,
    embedding_fingerprint: null,
  };
}
