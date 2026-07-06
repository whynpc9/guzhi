import { embedBatch } from "./embedding.js";
import {
  deserializeFacets,
  deserializeFlags,
  deserializeHeadingPath,
  type StorageAdapter,
} from "./storage.js";
import type { ChunkRow, JsonRecord, SearchResult, WenguConfig } from "./types.js";
import { tokenize, tokenizeTerms } from "./tokenize.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_FIELD_WEIGHT = 4;
const SLUG_FIELD_WEIGHT = 3;

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
  storage: StorageAdapter,
  config: WenguConfig,
  query: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  const rows = await storage.fetchSearchCorpus(options.filters);
  const tokens = tokenize(query);
  const keywordScores = scoreKeywordBm25(rows, query, tokens);
  let vectorScores = new Map<string, number>();
  const stats = await storage.getStats();
  const diagnostics: JsonRecord = {
    index_age: stats.last_sync,
    docs_pending_sync: 0,
    tokens,
    keyword_algorithm: "bm25",
    keyword_corpus_chunks: rows.length,
    rank_fusion: config.search.rank_fusion,
    rrf_k: config.search.rrf_k,
  };
  let retrievalMode: "hybrid" | "keyword_only" = "keyword_only";

  if (
    config.search.mode !== "keyword" &&
    config.embedding.provider !== "none" &&
    stats.embedded_chunks > 0
  ) {
    try {
      const [queryVector] = await embedBatch([query], config.embedding);
      vectorScores = await storage.scoreVectors(rows, queryVector, 50);
      retrievalMode = vectorScores.size > 0 ? "hybrid" : "keyword_only";
    } catch (error) {
      diagnostics.vector_error = error instanceof Error ? error.message : String(error);
    }
  }

  const fused = fuseScores(
    rows,
    keywordScores,
    vectorScores,
    config.search,
    options.explain ?? false,
  );
  return {
    retrieval_mode: retrievalMode,
    results: poolByDocument(fused, options.k),
    diagnostics,
  };
}

interface Bm25Document {
  row: ChunkRow;
  termFrequency: Map<string, number>;
  length: number;
}

function scoreKeywordBm25(rows: ChunkRow[], query: string, tokens: string[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (rows.length === 0 || tokens.length === 0) return scores;

  const documents = rows.map(toBm25Document);
  const averageLength =
    documents.reduce((sum, document) => sum + Math.max(document.length, 1), 0) / documents.length;
  const documentFrequency = documentFrequencies(documents, tokens);
  const normalizedQuery = query.toLowerCase().trim();

  for (const document of documents) {
    let score = exactMetadataBoost(document.row, normalizedQuery);
    for (const token of tokens) {
      const termFrequency = document.termFrequency.get(token) ?? 0;
      if (termFrequency === 0) continue;

      const frequency = documentFrequency.get(token) ?? 0;
      if (frequency === 0) continue;

      const idf = Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5));
      const lengthRatio = document.length / averageLength;
      const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
      score += idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
    }
    if (score > 0) scores.set(document.row.chunk_uid, score);
  }
  return scores;
}

function toBm25Document(row: ChunkRow): Bm25Document {
  const terms = tokenizeTerms(keywordDocumentText(row));
  const termFrequency = new Map<string, number>();
  for (const term of terms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }
  return {
    row,
    termFrequency,
    length: Math.max(terms.length, 1),
  };
}

function keywordDocumentText(row: ChunkRow): string {
  return [
    repeatField(row.title ?? "", TITLE_FIELD_WEIGHT),
    repeatField(normalizeSlugText(row.slug), SLUG_FIELD_WEIGHT),
    row.body,
  ].join("\n");
}

function repeatField(value: string, times: number): string {
  return Array.from({ length: times }, () => value).join("\n");
}

function normalizeSlugText(slug: string): string {
  return slug.replace(/[./_-]+/g, " ");
}

function documentFrequencies(documents: Bm25Document[], tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of tokens) {
      if (!document.termFrequency.has(token)) continue;
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
  }
  return frequencies;
}

function exactMetadataBoost(row: ChunkRow, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const title = row.title?.toLowerCase().normalize("NFKC") ?? "";
  const slug = row.slug.toLowerCase().normalize("NFKC");
  const slugPhrase = normalizedQuery.replace(/\s+/g, "-");
  let score = 0;
  if (title.includes(normalizedQuery)) score += 2;
  if (slug.includes(slugPhrase) || normalizeSlugText(slug).includes(normalizedQuery)) score += 2.5;
  return score;
}

function fuseScores(
  rows: ChunkRow[],
  keywordScores: Map<string, number>,
  vectorScores: Map<string, number>,
  config: WenguConfig["search"],
  explain: boolean,
): SearchResult[] {
  const rowMap = new Map(rows.map((row) => [row.chunk_uid, row]));
  const keywordRanks = rankMap(keywordScores);
  const vectorRanks = rankMap(vectorScores);
  const ids = new Set([...keywordScores.keys(), ...vectorScores.keys()]);
  const results: SearchResult[] = [];
  const weights = rrfWeights(config);

  for (const id of ids) {
    const row = rowMap.get(id);
    if (!row) continue;
    const keywordRank = keywordRanks.get(id);
    const vectorRank = vectorRanks.get(id);
    const keywordRrf = keywordRank ? 1 / (config.rrf_k + keywordRank) : 0;
    const vectorRrf = vectorRank ? 1 / (config.rrf_k + vectorRank) : 0;
    const score = (keywordRrf * weights.keyword + vectorRrf * weights.vector) * Number(row.tier ?? 1);
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
            keyword_algorithm: "bm25",
            keyword_rrf: keywordRrf,
            keyword_weight: weights.keyword,
            vector_rank: vectorRank ?? null,
            vector_score: vectorScore,
            vector_rrf: vectorRrf,
            vector_weight: weights.vector,
            rank_fusion: config.rank_fusion,
            rrf_k: config.rrf_k,
            tier: row.tier,
          }
        : undefined,
    });
  }
  return results.sort((a, b) => b.score - a.score);
}

function rrfWeights(config: WenguConfig["search"]): { keyword: number; vector: number } {
  if (config.rank_fusion === "weighted_rrf") {
    return config.rrf_weights;
  }
  return { keyword: 1, vector: 1 };
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
