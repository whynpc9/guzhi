import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseMarkdownDocument } from "../src/markdown.js";
import { runSearch } from "../src/search.js";
import { openStorage } from "../src/storage.js";
import { runSync } from "../src/sync.js";

const dockerEnabled = process.env.WENGU_DOCKER_TESTS === "1";
const describeDocker = dockerEnabled ? describe : describe.skip;

describeDocker("docker-backed storage adapters", () => {
  it("syncs and searches against PostgreSQL catalog storage", async () => {
    const root = await makeTinyRepo();
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        storageBackend: "postgres",
        storageUrl: process.env.WENGU_TEST_POSTGRES_URL ?? "postgres://wengu:wengu@localhost:55432/wengu",
        embeddingProvider: "none",
      });
      const summary = await runSync(loaded, { full: true, noEmbed: true, breakLock: true });
      expect(summary.indexed).toBe(2);

      const storage = await openStorage(loaded.config);
      try {
        const stats = await storage.getStats();
        expect(stats.documents_active).toBe(2);
        const search = await runSearch(storage, loaded.config, "alpha stent", { k: 3, filters: {} });
        expect(search.results[0]?.path).toBe("concepts/alpha.md");
      } finally {
        await storage.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores and searches vectors in Milvus while keeping catalog in PGlite", async () => {
    const root = await makeTinyRepo();
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        storageBackend: "milvus",
        milvusAddress: process.env.WENGU_TEST_MILVUS_ADDRESS ?? "localhost:19530",
        milvusCollection: `wengu_test_${Date.now()}`,
        embeddingProvider: "openai-compatible",
        embeddingBaseUrl: "http://127.0.0.1:9/v1/embeddings",
        embeddingModel: "test-embedding",
        embeddingDimensions: 4,
      });
      const storage = await openStorage(loaded.config);
      try {
        await storage.resetIndex();
        const file = path.join(root, "concepts", "alpha.md");
        const parsed = await parseMarkdownDocument("concepts/alpha.md", file, loaded.config);
        await storage.upsertDocument(parsed, loaded.config.embedding);
        const queued = await storage.listQueuedChunks(10);
        expect(queued.length).toBeGreaterThan(0);
        for (const chunk of queued) {
          await storage.fulfillEmbedding(chunk.chunk_uid, chunk.content_hash, [1, 0, 0, 0], loaded.config.embedding);
        }
        await storage.flushVectorIndex();
        const scores = await storage.scoreVectors(await storage.fetchSearchCorpus({}), [1, 0, 0, 0], queued.length);
        for (const chunk of queued) {
          expect(scores.get(chunk.chunk_uid)).toBeGreaterThan(0.9);
        }

        await storage.resetIndex();
        await storage.upsertDocument(parsed, loaded.config.embedding);
        expect(await storage.listQueuedChunks(1)).toHaveLength(0);
        await storage.flushVectorIndex();
        const cachedCorpus = await storage.fetchSearchCorpus({});
        const cachedScores = await storage.scoreVectors(cachedCorpus, [1, 0, 0, 0], cachedCorpus.length);
        for (const chunk of cachedCorpus) {
          expect(cachedScores.get(chunk.chunk_uid)).toBeGreaterThan(0.9);
        }
      } finally {
        await storage.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

async function makeTinyRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wengu-docker-"));
  await mkdir(path.join(root, "concepts"), { recursive: true });
  await writeFile(
    path.join(root, "concepts", "alpha.md"),
    [
      "---",
      "title: Alpha stent workflow",
      "type: concept",
      "coding_system: clinical",
      "---",
      "# Alpha",
      "冠状动脉 stent principal procedure workflow.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "concepts", "beta.md"),
    [
      "---",
      "title: Beta diagnosis workflow",
      "type: concept",
      "---",
      "# Beta",
      "A diagnosis routing page.",
    ].join("\n"),
    "utf8",
  );
  return root;
}
