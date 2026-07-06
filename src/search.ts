import { embedBatch } from "./embedding.js";
import {
  deserializeFacets,
  deserializeFlags,
  deserializeHeadingPath,
  PgliteStorage,
} from "./storage.js";
import type { ChunkRow, JsonRecord, SearchResult, WenguConfig } from "./types.js";
import { countTokenOccurrences, tokenize } from "./tokenize.js";

export interface SearchOptions {
  k: number;
  filters: Record<string, string>;
  explain?: boolean;
}

export interface SearchResponse {
  retrieval_mode: "hybrid" | "keyword_only";
  results: SearchResult[];
  diagnostics: JsonRecord;
}

export async function runSearch(
  storage: PgliteStorage,
  config: WenguConfig,
  query: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  const rows = await storage.fetchSearchCorpus(options.filters);
  const tokens = tokenize(query);
  const keywordScores = scoreKeyword(rows, query, tokens);
  let vectorScores = new Map<string, number>();
  const stats = await storage.getStats();
  const diagnostics: JsonRecord = {
    index_age: stats.last_sync,
    docs_pending_sync: 0,
    tokens,
  };
  let retrievalMode: "hybrid" | "keyword_only" = "keyword_only";

  if (
    config.search.mode !== "keyword" &&
    config.embedding.provider !== "none" &&
    stats.embedded_chunks > 0
  ) {
    try {
      const [queryVector] = await embedBatch([query], config.embedding);
      vectorScores = storage.scoreVectors(rows, queryVector);
      retrievalMode = vectorScores.size > 0 ? "hybrid" : "keyword_only";
    } catch (error) {
      diagnostics.vector_error = error instanceof Error ? error.message : String(error);
    }
  }

  const fused = fuseScores(rows, keywordScores, vectorScores, config.search.rrf_k, options.explain ?? false);
  return {
    retrieval_mode: retrievalMode,
    results: poolByDocument(fused, options.k),
    diagnostics,
  };
}

function scoreKeyword(rows: ChunkRow[], query: string, tokens: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  const normalizedQuery = query.toLowerCase().trim();
  for (const row of rows) {
    const bodyScore = countTokenOccurrences(row.body, tokens);
    const title = row.title?.toLowerCase() ?? "";
    const slug = row.slug.toLowerCase();
    const titleBoost = normalizedQuery && title.includes(normalizedQuery) ? 8 : 0;
    const slugBoost = normalizedQuery && slug.includes(normalizedQuery.replace(/\s+/g, "-")) ? 10 : 0;
    const score = bodyScore + titleBoost + slugBoost;
    if (score > 0) scores.set(row.chunk_uid, score);
  }
  return scores;
}

function fuseScores(
  rows: ChunkRow[],
  keywordScores: Map<string, number>,
  vectorScores: Map<string, number>,
  rrfK: number,
  explain: boolean,
): SearchResult[] {
  const rowMap = new Map(rows.map((row) => [row.chunk_uid, row]));
  const keywordRanks = rankMap(keywordScores);
  const vectorRanks = rankMap(vectorScores);
  const ids = new Set([...keywordScores.keys(), ...vectorScores.keys()]);
  const results: SearchResult[] = [];

  for (const id of ids) {
    const row = rowMap.get(id);
    if (!row) continue;
    const keywordRank = keywordRanks.get(id);
    const vectorRank = vectorRanks.get(id);
    const keywordRrf = keywordRank ? 1 / (rrfK + keywordRank) : 0;
    const vectorRrf = vectorRank ? 1 / (rrfK + vectorRank) : 0;
    const score = (keywordRrf + vectorRrf) * Number(row.tier ?? 1);
    const keywordScore = keywordScores.get(id) ?? 0;
    const vectorScore = vectorScores.get(id) ?? 0;
    results.push({
      path: row.path,
      slug: row.slug,
      title: row.title,
      heading_path: deserializeHeadingPath(row.heading_path),
      snippet: makeSnippet(row.body),
      score,
      evidence: chooseEvidence(keywordScore, vectorScore, row.seq),
      tier: Number(row.tier ?? 1),
      facets: deserializeFacets(row.facets),
      status_flags: deserializeFlags(row.flags),
      explain: explain
        ? {
            keyword_rank: keywordRank ?? null,
            keyword_score: keywordScore,
            vector_rank: vectorRank ?? null,
            vector_score: vectorScore,
            tier: row.tier,
          }
        : undefined,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

function rankMap(scores: Map<string, number>): Map<string, number> {
  return new Map(
    [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id], index) => [id, index + 1]),
  );
}

function poolByDocument(results: SearchResult[], k: number): SearchResult[] {
  const bestByPath = new Map<string, SearchResult>();
  for (const result of results) {
    const existing = bestByPath.get(result.path);
    if (!existing || result.score > existing.score) {
      bestByPath.set(result.path, result);
    }
  }
  return [...bestByPath.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

function makeSnippet(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function chooseEvidence(keywordScore: number, vectorScore: number, seq: number): string {
  if (seq === 0 && keywordScore > 0) return "title_match";
  if (keywordScore >= 3) return "keyword_exact";
  if (vectorScore > 0.78) return "high_vector_match";
  if (vectorScore > 0) return "vector_match";
  return "keyword_match";
}
