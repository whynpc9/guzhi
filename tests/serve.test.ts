import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type ServeRuntime } from "../src/serve.js";
import { runSync } from "../src/sync.js";

describe("HTTP serve", () => {
  it("serves Dify external knowledge retrieval with bearer auth and metadata filtering", async () => {
    const root = await makeTinyRepo();
    let runtime: ServeRuntime | undefined;
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "none",
        searchMode: "keyword",
      });
      await runSync(loaded, { full: true, noEmbed: true, breakLock: true });
      runtime = await startHttpServer(loaded, {
        host: "127.0.0.1",
        port: 0,
        apiKey: "secret",
        knowledgeId: "wiki",
      });

      const unauthorized = await fetch(`${runtime.url}/retrieval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          knowledge_id: "wiki",
          query: "alpha",
          retrieval_setting: { top_k: 3, score_threshold: 0 },
        }),
      });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toMatchObject({ error_code: 1001 });

      const response = await fetch(`${runtime.url}/retrieval`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          knowledge_id: "wiki",
          query: "alpha",
          retrieval_setting: { top_k: 3, score_threshold: 0.5 },
          metadata_condition: {
            logical_operator: "and",
            conditions: [
              { name: "safe_for_daily_qa", comparison_operator: "is", value: true },
            ],
          },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.records.length).toBeGreaterThan(0);
      expect(payload.records).toHaveLength(2);
      expect(payload.records.map((record: { metadata: { path: string } }) => record.metadata.path)).toEqual([
        "concepts/alpha.md",
        "concepts/alpha.md",
      ]);
      expect(payload.records.map((record: { content: string }) => record.content).join("\n")).toContain(
        "alpha clinical evidence",
      );
      expect(payload.records[0].score).toBeGreaterThanOrEqual(0.5);
      expect(payload.records[0].metadata.facets.safe_for_daily_qa).toBe(true);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves generic search for RAGFlow HTTP request workflows", async () => {
    const root = await makeTinyRepo();
    let runtime: ServeRuntime | undefined;
    try {
      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        dataDir: path.join(root, ".guzhi", "db"),
        embeddingProvider: "none",
        searchMode: "keyword",
      });
      await runSync(loaded, { full: true, noEmbed: true, breakLock: true });
      runtime = await startHttpServer(loaded, { host: "127.0.0.1", port: 0 });

      const health = await fetch(`${runtime.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, documents_active: 2 });

      const response = await fetch(`${runtime.url}/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "beta",
          k: 5,
          filters: { safe_for_daily_qa: false },
        }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.count).toBe(2);
      expect(payload.results.map((result: { path: string }) => result.path)).toEqual([
        "concepts/beta.md",
        "concepts/beta.md",
      ]);
      expect(payload.results.map((result: { content: string }) => result.content).join("\n")).toContain(
        "beta operational evidence",
      );
      expect(payload.results[0].metadata.normalized_score).toBe(payload.results[0].score);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeTinyRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-serve-"));
  await mkdir(path.join(root, "concepts"), { recursive: true });
  await writeFile(
    path.join(root, "concepts", "alpha.md"),
    [
      "---",
      "title: Alpha",
      "safe_for_daily_qa: true",
      "---",
      "# Alpha",
      "",
      "alpha clinical evidence for Dify retrieval.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(root, "concepts", "beta.md"),
    [
      "---",
      "title: Beta",
      "safe_for_daily_qa: false",
      "---",
      "# Beta",
      "",
      "beta operational evidence for RAGFlow HTTP search.",
    ].join("\n"),
    "utf8",
  );
  return root;
}
