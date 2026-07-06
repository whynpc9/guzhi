import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { runSearch } from "../src/search.js";
import type { Stats, StorageAdapter } from "../src/storage.js";
import type { ChunkRow, WenguConfig } from "../src/types.js";

vi.mock("../src/embedding.js", () => ({
  embedBatch: vi.fn(async () => [[1, 0, 0]]),
}));

describe("runSearch keyword BM25", () => {
  it("ranks rare query terms above repeated common terms", async () => {
    const result = await searchRows("alpha zeta", [
      chunkRow({
        chunk_uid: "common",
        path: "concepts/common-alpha.md",
        slug: "common-alpha",
        title: "Common alpha",
        body: `${"alpha ".repeat(20)}routine workflow`,
      }),
      chunkRow({
        chunk_uid: "rare",
        path: "concepts/rare-zeta.md",
        slug: "rare-zeta",
        title: "Rare zeta",
        body: "alpha zeta targeted guide",
      }),
    ]);

    expect(result.results[0]?.path).toBe("concepts/rare-zeta.md");
    expect(result.diagnostics.keyword_algorithm).toBe("bm25");
    expect(result.results[0]?.explain?.keyword_algorithm).toBe("bm25");
  });

  it("keeps title and slug text in the keyword corpus", async () => {
    const result = await searchRows("gamma catheter", [
      chunkRow({
        chunk_uid: "body-only",
        path: "concepts/body-only.md",
        slug: "body-only",
        title: "Body only",
        body: "gamma appears without the device family.",
      }),
      chunkRow({
        chunk_uid: "title-slug",
        path: "concepts/gamma-catheter.md",
        slug: "gamma-catheter",
        title: "Gamma catheter pathway",
        body: "A routing note with no repeated query phrase.",
      }),
    ]);

    expect(result.results[0]?.path).toBe("concepts/gamma-catheter.md");
  });
});

describe("runSearch rank fusion", () => {
  it("keeps ordinary RRF unweighted", async () => {
    const result = await searchRows(
      "alpha",
      [
        chunkRow({
          chunk_uid: "keyword",
          path: "concepts/keyword.md",
          slug: "keyword",
          title: "Keyword",
          body: "alpha keyword evidence",
        }),
        chunkRow({
          chunk_uid: "vector",
          path: "concepts/vector.md",
          slug: "vector",
          title: "Vector",
          body: "semantic evidence",
        }),
      ],
      {
        searchMode: "hybrid",
        vectorScores: new Map([["vector", 0.95]]),
      },
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.score).toBeCloseTo(result.results[1]?.score ?? 0);
    expect(result.results[0]?.explain?.rank_fusion).toBe("rrf");
    expect(result.results[0]?.explain?.keyword_weight).toBe(1);
    expect(result.results[1]?.explain?.vector_weight).toBe(1);
  });

  it("can favor a retrieval channel with Weighted RRF", async () => {
    const result = await searchRows(
      "alpha",
      [
        chunkRow({
          chunk_uid: "keyword",
          path: "concepts/keyword.md",
          slug: "keyword",
          title: "Keyword",
          body: "alpha keyword evidence",
        }),
        chunkRow({
          chunk_uid: "vector",
          path: "concepts/vector.md",
          slug: "vector",
          title: "Vector",
          body: "semantic evidence",
        }),
      ],
      {
        searchMode: "hybrid",
        rankFusion: "weighted_rrf",
        rrfWeights: { keyword: 1, vector: 3 },
        vectorScores: new Map([["vector", 0.95]]),
      },
    );

    expect(result.results[0]?.path).toBe("concepts/vector.md");
    expect(result.results[0]?.explain?.rank_fusion).toBe("weighted_rrf");
    expect(result.results[0]?.explain?.vector_weight).toBe(3);
  });

  it("loads Weighted RRF settings from config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wengu-config-"));
    try {
      await writeFile(
        path.join(root, "wengu.toml"),
        [
          "[search]",
          'rank_fusion = "weighted_rrf"',
          "rrf_k = 20",
          "",
          "[search.rrf_weights]",
          "keyword = 0.5",
          "vector = 2.0",
        ].join("\n"),
        "utf8",
      );

      const loaded = await loadConfig({
        cwd: root,
        repoRoot: root,
        embeddingProvider: "none",
      });

      expect(loaded.config.search.rank_fusion).toBe("weighted_rrf");
      expect(loaded.config.search.rrf_k).toBe(20);
      expect(loaded.config.search.rrf_weights).toEqual({ keyword: 0.5, vector: 2 });
      expect(loaded.sources["search.rank_fusion"]).toBe("toml");
      expect(loaded.sources["search.rrf_weights.keyword"]).toBe("toml");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface SearchRowsOptions {
  searchMode?: "hybrid" | "keyword" | "vector";
  rankFusion?: WenguConfig["search"]["rank_fusion"];
  rrfWeights?: WenguConfig["search"]["rrf_weights"];
  vectorScores?: Map<string, number>;
}

async function searchRows(query: string, rows: ChunkRow[], options: SearchRowsOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wengu-search-"));
  try {
    const loaded = await loadConfig({
      cwd: root,
      repoRoot: root,
      embeddingProvider: options.vectorScores ? "openai-compatible" : "none",
      searchMode: options.searchMode ?? "keyword",
    });
    if (options.rankFusion) loaded.config.search.rank_fusion = options.rankFusion;
    if (options.rrfWeights) loaded.config.search.rrf_weights = options.rrfWeights;
    return await runSearch(fakeStorage(rows, options.vectorScores), loaded.config, query, {
      k: rows.length,
      filters: {},
      explain: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeStorage(rows: ChunkRow[], vectorScores = new Map<string, number>()): StorageAdapter {
  return {
    fetchSearchCorpus: async () => rows,
    getStats: async () => fakeStats(rows.length, vectorScores.size),
    scoreVectors: async () => vectorScores,
  } as unknown as StorageAdapter;
}

function fakeStats(chunks: number, embeddedChunks = 0): Stats {
  return {
    documents_active: chunks,
    documents_deleted: 0,
    chunks,
    links: 0,
    broken_links: 0,
    ambiguous_links: 0,
    queued_embeddings: 0,
    failed_embeddings: 0,
    embedded_chunks: embeddedChunks,
    retrieval_mode: "keyword_only",
    last_sync: null,
    embedding_fingerprint: null,
  };
}

function chunkRow(overrides: Partial<ChunkRow>): ChunkRow {
  return {
    chunk_uid: "chunk",
    doc_id: "doc",
    path: "concepts/chunk.md",
    slug: "chunk",
    title: "Chunk",
    seq: 0,
    heading_path: [],
    body: "",
    token_est: 1,
    content_hash: "hash",
    embedding: null,
    tier: 1,
    facets: {},
    flags: [],
    ...overrides,
  };
}
