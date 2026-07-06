import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseMarkdownDocument } from "../src/markdown.js";
import { openStorage } from "../src/storage.js";
import { runSync } from "../src/sync.js";

describe("runSync", () => {
  it("allows --full to rebuild after embedding fingerprint drift", async () => {
    const root = await makeTinyRepo();
    try {
      const oldConfig = await loadConfig({
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "openai-compatible",
        embeddingBaseUrl: "http://127.0.0.1:9/v1/embeddings",
        embeddingModel: "old-model",
        embeddingDimensions: 4,
      });
      const storage = await openStorage(oldConfig.config);
      try {
        await storage.setEmbeddingFingerprint(oldConfig.config.embedding, 4);
      } finally {
        await storage.close();
      }

      const newConfig = await loadConfig({
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "openai-compatible",
        embeddingBaseUrl: "http://127.0.0.1:9/v1/embeddings",
        embeddingModel: "new-model",
        embeddingDimensions: 8,
      });
      const summary = await runSync(newConfig, { full: true, noEmbed: true, breakLock: true });

      expect(summary.status).toBe("success");
      expect(summary.indexed).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("tombstones active files that grow beyond discovery.max_file_bytes", async () => {
    const root = await makeTinyRepo();
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "none",
      });
      await runSync(loaded, { full: true, noEmbed: true, breakLock: true });

      await writeFile(path.join(root, "concepts", "alpha.md"), "# Alpha\nlarge body\n", "utf8");
      loaded.config.discovery.max_file_bytes = 1;
      const summary = await runSync(loaded, { noEmbed: true, breakLock: true });

      expect(summary.excluded).toBe(1);
      expect(summary.diagnostics).toBe(1);
      const storage = await openStorage(loaded.config);
      try {
        const stats = await storage.getStats();
        expect(stats.documents_active).toBe(0);
        expect(stats.documents_deleted).toBe(1);
      } finally {
        await storage.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("embedding cache", () => {
  it("does not reuse cached vectors with a different configured dimension", async () => {
    const root = await makeTinyRepo();
    try {
      const base = {
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "openai-compatible" as const,
        embeddingBaseUrl: "http://127.0.0.1:9/v1/embeddings",
        embeddingModel: "same-model",
      };
      const fourDim = await loadConfig({ ...base, embeddingDimensions: 4 });
      const storage = await openStorage(fourDim.config);
      try {
        const file = path.join(root, "concepts", "alpha.md");
        const parsed = await parseMarkdownDocument("concepts/alpha.md", file, fourDim.config);
        await storage.upsertDocument(parsed, fourDim.config.embedding);
        const queued = await storage.listQueuedChunks(10);
        expect(queued.length).toBeGreaterThan(0);
        for (const chunk of queued) {
          await storage.fulfillEmbedding(chunk.chunk_uid, chunk.content_hash, [1, 0, 0, 0], fourDim.config.embedding);
        }

        const eightDim = await loadConfig({ ...base, embeddingDimensions: 8 });
        const reparsed = await parseMarkdownDocument("concepts/alpha.md", file, eightDim.config);
        await storage.upsertDocument(reparsed, eightDim.config.embedding);

        expect(await storage.listQueuedChunks(10)).toHaveLength(queued.length);
      } finally {
        await storage.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeTinyRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-sync-"));
  await mkdir(path.join(root, "concepts"), { recursive: true });
  await writeFile(path.join(root, "concepts", "alpha.md"), "# Alpha\nbody\n", "utf8");
  return root;
}
