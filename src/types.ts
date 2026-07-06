export type JsonRecord = Record<string, unknown>;

export interface RepoConfig {
  root: string;
  flavor: "auto" | "okf" | "obsidian" | "plain";
}

export interface DiscoveryConfig {
  include: string[];
  exclude: string[];
  respect_gitignore: boolean;
  follow_symlinks: boolean;
  max_file_bytes: number;
  exclude_frontmatter_flags: string[];
}

export interface StorageConfig {
  backend: "pglite";
  data_dir: string;
}

export interface EmbeddingConfig {
  provider: "openai-compatible" | "none";
  base_url: string;
  model: string;
  dimensions: number;
  batch_size: number;
  max_batch_tokens: number;
  max_input_tokens: number;
  request_dimensions: boolean;
  timeout_ms: number;
}

export interface ChunkingConfig {
  target_tokens: number;
  max_tokens: number;
  overlap_tokens: number;
  cjk_char_per_token: number;
}

export interface SearchConfig {
  mode: "hybrid" | "keyword" | "vector";
  rrf_k: number;
  tier_boost: Record<string, number>;
}

export interface WenguConfig {
  repo: RepoConfig;
  discovery: DiscoveryConfig;
  storage: StorageConfig;
  embedding: EmbeddingConfig;
  chunking: ChunkingConfig;
  search: SearchConfig;
}

export interface LoadedConfig {
  config: WenguConfig;
  sources: Record<string, string>;
  configPath: string | null;
  projectRoot: string;
}

export interface Diagnostic {
  kind: string;
  message: string;
  path?: string;
  line?: number;
}

export interface ParsedFrontmatter {
  raw: JsonRecord;
  normalized: {
    title?: string;
    type?: string;
    description?: string;
    tags: string[];
    created_ts?: string;
    updated_ts?: string;
    facets: JsonRecord;
  };
  hash: string;
  diagnostics: Diagnostic[];
  excluded: boolean;
}

export type LinkKind =
  | "wikilink"
  | "mdlink_absolute"
  | "mdlink_relative"
  | "footnote_source"
  | "external";

export interface ExtractedLink {
  kind: LinkKind;
  rawTarget: string;
  normalizedTarget: string;
  anchor: string | null;
  alias: string | null;
}

export interface ParsedChunk {
  seq: number;
  headingPath: string[];
  anchor: string | null;
  body: string;
  tokenEstimate: number;
  contentHash: string;
  flags: string[];
}

export interface ParsedDocument {
  path: string;
  absolutePath: string;
  slug: string;
  conceptId: string;
  title: string;
  type: string | null;
  description: string | null;
  tags: string[];
  createdTs: string | null;
  updatedTs: string | null;
  facets: JsonRecord;
  frontmatterRaw: JsonRecord;
  contentHash: string;
  frontmatterHash: string;
  sizeBytes: number;
  fileMtime: number;
  tier: number;
  reserved: boolean;
  diagnostics: Diagnostic[];
  chunks: ParsedChunk[];
  links: ExtractedLink[];
  excluded: boolean;
}

export interface DocumentRow {
  doc_id: string;
  path: string;
  slug: string;
  title: string | null;
  type: string | null;
  description: string | null;
  tags: unknown;
  facets: unknown;
  content_hash: string;
  frontmatter_hash: string;
  tier: number;
  reserved: boolean;
  status: "active" | "deleted";
}

export interface ChunkRow {
  chunk_uid: string;
  doc_id: string;
  path: string;
  slug: string;
  title: string | null;
  seq: number;
  heading_path: unknown;
  body: string;
  token_est: number;
  content_hash: string;
  embedding: unknown;
  tier: number;
  facets: unknown;
  flags: unknown;
}

export interface SearchResult {
  path: string;
  slug: string;
  title: string | null;
  heading_path: string[];
  snippet: string;
  score: number;
  evidence: string;
  tier: number;
  facets: JsonRecord;
  status_flags: string[];
  explain?: JsonRecord;
}

export class WenguError extends Error {
  constructor(
    public readonly kind: "config" | "transient",
    message: string,
    public readonly fixHint?: string,
  ) {
    super(message);
    this.name = "WenguError";
  }
}
