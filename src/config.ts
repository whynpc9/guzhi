import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import type { LoadedConfig, GuzhiConfig } from "./types.js";
import { GuzhiError } from "./types.js";
import { stripTrailingSlash } from "./util.js";

const DEFAULT_CONFIG: GuzhiConfig = {
  repo: {
    root: ".",
    flavor: "auto",
  },
  discovery: {
    include: ["**/*.md"],
    exclude: [
      "_eval/**",
      "skills/**",
      "templates/**",
      ".obsidian/**",
      ".hermes/**",
      "tmp/**",
      "_plans/**",
      ".git/**",
      ".guzhi/**",
      "node_modules/**",
    ],
    respect_gitignore: true,
    follow_symlinks: false,
    max_file_bytes: 20_000_000,
    exclude_frontmatter_flags: ["excluded_from_wiki_knowledge_base"],
  },
  storage: {
    backend: "pglite",
    data_dir: ".guzhi/db",
    url: "",
    catalog_backend: "pglite",
    milvus_address: "localhost:19530",
    milvus_collection: "guzhi_chunks",
    milvus_database: "",
    milvus_token: "",
    milvus_username: "",
    milvus_password: "",
    milvus_ssl: false,
  },
  embedding: {
    provider: "none",
    base_url: "https://api.openai.com/v1/embeddings",
    model: "text-embedding-3-small",
    dimensions: 1536,
    batch_size: 64,
    max_batch_tokens: 30_000,
    max_input_tokens: 8_000,
    request_dimensions: false,
    timeout_ms: 120_000,
  },
  chunking: {
    target_tokens: 400,
    max_tokens: 800,
    overlap_tokens: 60,
    cjk_char_per_token: 1.6,
  },
  search: {
    mode: "hybrid",
    rank_fusion: "rrf",
    rrf_k: 60,
    rrf_weights: {
      keyword: 1,
      vector: 1,
    },
    tier_boost: {
      "queries/": 1.5,
      "concepts/": 1.3,
      "comparisons/": 1.1,
      "_meta/": 0.8,
      "raw/": 0.5,
    },
  },
};

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
  repoRoot?: string;
  dataDir?: string;
  storageBackend?: "pglite" | "postgres" | "milvus";
  storageUrl?: string;
  catalogBackend?: "pglite" | "postgres";
  milvusAddress?: string;
  milvusCollection?: string;
  embeddingProvider?: "openai-compatible" | "none";
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  searchMode?: "hybrid" | "keyword" | "vector";
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const projectRoot = options.cwd;
  const configPath = await resolveConfigPath(projectRoot, options.configPath);
  const sources: Record<string, string> = {};
  let config = cloneConfig(DEFAULT_CONFIG);
  markDefaults(config, sources);

  if (configPath) {
    const raw = await readFile(configPath, "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    config = mergeConfig(config, parsed, sources, "toml");
  }

  config = applyEnv(config, sources);
  config = applyOverrides(config, options, sources);
  config = normalizePaths(config, projectRoot);
  validateConfig(config);

  return { config, sources, configPath, projectRoot };
}

export async function writeInitialConfig(
  cwd: string,
  configPath: string,
  overrides: Partial<LoadConfigOptions>,
): Promise<GuzhiConfig> {
  const outputPath = path.resolve(cwd, configPath);
  const initial = cloneConfig(DEFAULT_CONFIG);
  if (overrides.repoRoot) initial.repo.root = overrides.repoRoot;
  if (overrides.storageBackend) initial.storage.backend = overrides.storageBackend;
  if (overrides.storageUrl) initial.storage.url = overrides.storageUrl;
  if (overrides.catalogBackend) initial.storage.catalog_backend = overrides.catalogBackend;
  if (overrides.dataDir) initial.storage.data_dir = overrides.dataDir;
  if (overrides.milvusAddress) initial.storage.milvus_address = overrides.milvusAddress;
  if (overrides.milvusCollection) initial.storage.milvus_collection = overrides.milvusCollection;
  if (overrides.embeddingProvider) initial.embedding.provider = overrides.embeddingProvider;
  if (overrides.embeddingBaseUrl) initial.embedding.base_url = overrides.embeddingBaseUrl;
  if (overrides.embeddingModel) initial.embedding.model = overrides.embeddingModel;
  if (overrides.embeddingDimensions) initial.embedding.dimensions = overrides.embeddingDimensions;

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${stringify(initial as unknown as Record<string, unknown>)}\n`, "utf8");
  return normalizePaths(initial, cwd);
}

function cloneConfig(input: GuzhiConfig): GuzhiConfig {
  return JSON.parse(JSON.stringify(input)) as GuzhiConfig;
}

async function resolveConfigPath(cwd: string, explicit?: string): Promise<string | null> {
  if (explicit) {
    const resolved = path.resolve(cwd, explicit);
    try {
      await access(resolved);
      return resolved;
    } catch {
      throw new GuzhiError("config", `Config file not found: ${resolved}`, "Run `guzhi init` first.");
    }
  }
  const candidate = path.resolve(cwd, "guzhi.toml");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function markDefaults(value: unknown, sources: Record<string, string>, prefix = ""): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      markDefaults(child, sources, next);
    } else {
      sources[next] = "default";
    }
  }
}

function mergeConfig(
  config: GuzhiConfig,
  patch: Record<string, unknown>,
  sources: Record<string, string>,
  source: string,
  prefix = "",
): GuzhiConfig {
  for (const [key, value] of Object.entries(patch)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const target = getByPath(config as unknown as Record<string, unknown>, pathKey);
    if (target && typeof target === "object" && !Array.isArray(target) && isPlainObject(value)) {
      mergeConfig(config, value as Record<string, unknown>, sources, source, pathKey);
    } else {
      setByPath(config as unknown as Record<string, unknown>, pathKey, value);
      sources[pathKey] = source;
    }
  }
  return config;
}

function applyEnv(config: GuzhiConfig, sources: Record<string, string>): GuzhiConfig {
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!envKey.startsWith("GUZHI_") || value === undefined) continue;
    const key = envKey
      .slice("GUZHI_".length)
      .toLowerCase()
      .split("__")
      .join(".");
    const existing = getByPath(config as unknown as Record<string, unknown>, key);
    setByPath(config as unknown as Record<string, unknown>, key, coerceEnvValue(value, existing));
    sources[key] = `env:${envKey}`;
  }
  return config;
}

function applyOverrides(
  config: GuzhiConfig,
  options: LoadConfigOptions,
  sources: Record<string, string>,
): GuzhiConfig {
  const overrides: Record<string, unknown> = {};
  if (options.repoRoot) overrides["repo.root"] = options.repoRoot;
  if (options.storageBackend) overrides["storage.backend"] = options.storageBackend;
  if (options.storageUrl) overrides["storage.url"] = options.storageUrl;
  if (options.catalogBackend) overrides["storage.catalog_backend"] = options.catalogBackend;
  if (options.dataDir) overrides["storage.data_dir"] = options.dataDir;
  if (options.milvusAddress) overrides["storage.milvus_address"] = options.milvusAddress;
  if (options.milvusCollection) overrides["storage.milvus_collection"] = options.milvusCollection;
  if (options.embeddingProvider) overrides["embedding.provider"] = options.embeddingProvider;
  if (options.embeddingBaseUrl) overrides["embedding.base_url"] = options.embeddingBaseUrl;
  if (options.embeddingModel) overrides["embedding.model"] = options.embeddingModel;
  if (options.embeddingDimensions) overrides["embedding.dimensions"] = options.embeddingDimensions;
  if (options.searchMode) overrides["search.mode"] = options.searchMode;
  for (const [key, value] of Object.entries(overrides)) {
    setByPath(config as unknown as Record<string, unknown>, key, value);
    sources[key] = "flag";
  }
  return config;
}

function normalizePaths(config: GuzhiConfig, projectRoot: string): GuzhiConfig {
  config.repo.root = stripTrailingSlash(path.resolve(projectRoot, config.repo.root));
  config.storage.data_dir = path.resolve(projectRoot, config.storage.data_dir);
  if (!config.embedding.base_url.endsWith("/embeddings")) {
    config.embedding.base_url = `${stripTrailingSlash(config.embedding.base_url)}/embeddings`;
  }
  return config;
}

function validateConfig(config: GuzhiConfig): void {
  if (!["pglite", "postgres", "milvus"].includes(config.storage.backend)) {
    throw new GuzhiError("config", `Unsupported storage backend: ${config.storage.backend}`);
  }
  if (!["pglite", "postgres"].includes(config.storage.catalog_backend)) {
    throw new GuzhiError("config", `Unsupported storage catalog_backend: ${config.storage.catalog_backend}`);
  }
  if (config.storage.backend === "postgres" && !config.storage.url) {
    throw new GuzhiError("config", "storage.url is required when storage.backend = \"postgres\".");
  }
  if (config.storage.backend === "milvus") {
    if (!config.storage.milvus_address) {
      throw new GuzhiError("config", "storage.milvus_address is required when storage.backend = \"milvus\".");
    }
    if (!config.storage.milvus_collection) {
      throw new GuzhiError("config", "storage.milvus_collection is required when storage.backend = \"milvus\".");
    }
    if (config.storage.catalog_backend === "postgres" && !config.storage.url) {
      throw new GuzhiError(
        "config",
        "storage.url is required when storage.backend = \"milvus\" and storage.catalog_backend = \"postgres\".",
      );
    }
    if (config.embedding.provider === "none") {
      throw new GuzhiError("config", "Milvus backend requires an embedding provider.");
    }
    if (config.embedding.dimensions <= 0) {
      throw new GuzhiError("config", "Milvus backend requires embedding.dimensions to be greater than 0.");
    }
  }
  if (config.embedding.provider === "openai-compatible") {
    if (!config.embedding.base_url) {
      throw new GuzhiError("config", "embedding.base_url is required for openai-compatible provider.");
    }
    if (!config.embedding.model) {
      throw new GuzhiError("config", "embedding.model is required for openai-compatible provider.");
    }
  }
  if (config.chunking.max_tokens < config.chunking.target_tokens) {
    throw new GuzhiError("config", "chunking.max_tokens must be >= chunking.target_tokens.");
  }
  if (!["hybrid", "keyword", "vector"].includes(config.search.mode)) {
    throw new GuzhiError("config", `Unsupported search mode: ${config.search.mode}`);
  }
  if (!["rrf", "weighted_rrf"].includes(config.search.rank_fusion)) {
    throw new GuzhiError("config", `Unsupported search rank_fusion: ${config.search.rank_fusion}`);
  }
  if (!Number.isFinite(config.search.rrf_k) || config.search.rrf_k <= 0) {
    throw new GuzhiError("config", "search.rrf_k must be greater than 0.");
  }
  validateRrfWeight("keyword", config.search.rrf_weights.keyword);
  validateRrfWeight("vector", config.search.rrf_weights.vector);
  if (
    config.search.rank_fusion === "weighted_rrf" &&
    config.search.rrf_weights.keyword === 0 &&
    config.search.rrf_weights.vector === 0
  ) {
    throw new GuzhiError("config", "weighted_rrf requires at least one positive search.rrf_weights value.");
  }
}

function validateRrfWeight(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new GuzhiError("config", `search.rrf_weights.${name} must be a non-negative number.`);
  }
}

function getByPath(target: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = target;
  for (const key of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setByPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let current = target;
  for (const key of parts.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function coerceEnvValue(value: string, existing: unknown): unknown {
  if (typeof existing === "boolean") return value === "true";
  if (typeof existing === "number") return Number(value);
  if (Array.isArray(existing)) return value.split(",").map((item) => item.trim());
  return value;
}

export function configForDisplay(loaded: LoadedConfig): Record<string, unknown> {
  return {
    config: loaded.config,
    sources: loaded.sources,
    config_path: loaded.configPath,
    project_root: loaded.projectRoot,
  };
}
