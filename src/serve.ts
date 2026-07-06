import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoadedConfig, ChunkRow, ChunkSearchResult, JsonRecord } from "./types.js";
import { GuzhiError } from "./types.js";
import { runChunkSearch } from "./search.js";
import { openStorage, type StorageAdapter } from "./storage.js";
import { jsonObject } from "./util.js";

const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 100;
const VALUELESS_METADATA_OPERATORS = new Set(["empty", "not empty"]);
const ARRAY_METADATA_OPERATORS = new Set(["in", "not in"]);
const SUPPORTED_METADATA_OPERATORS = new Set([
  "contains",
  "not contains",
  "start with",
  "end with",
  "is",
  "is not",
  "in",
  "not in",
  "empty",
  "not empty",
  "=",
  "!=",
  "≠",
  ">",
  "<",
  ">=",
  "≥",
  "<=",
  "≤",
  "before",
  "after",
]);

export interface ServeOptions {
  host: string;
  port: number;
  apiKey?: string;
  knowledgeId?: string;
  maxBodyBytes?: number;
}

export interface ServeRuntime {
  server: Server;
  url: string;
  close(): Promise<void>;
}

interface SearchForHttpOptions {
  query: string;
  k: number;
  scoreThreshold: number;
  filters: Record<string, string>;
  rowFilter?: (row: ChunkRow) => boolean;
}

interface NormalizedResult {
  result: ChunkSearchResult;
  score: number;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorCode?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function startHttpServer(
  loaded: LoadedConfig,
  options: ServeOptions,
): Promise<ServeRuntime> {
  const storage = await openStorage(loaded.config);
  const server = createServer((request, response) => {
    void handleRequest(request, response, loaded, storage, options).catch((error) => {
      writeError(response, error, isDifyPath(request.url));
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await listen(server, options.port, options.host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${formatHost(options.host)}:${port}`;

  return {
    server,
    url,
    close: async () => {
      await closeServer(server);
      await storage.close();
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  loaded: LoadedConfig,
  storage: StorageAdapter,
  options: ServeOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "OPTIONS") {
    writeJson(response, 204, null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const stats = await storage.getStats();
    writeJson(response, 200, {
      ok: true,
      service: "guzhi",
      repo_root: loaded.config.repo.root,
      storage_backend: loaded.config.storage.backend,
      retrieval_mode: stats.retrieval_mode,
      documents_active: stats.documents_active,
      chunks: stats.chunks,
      last_sync: stats.last_sync,
    });
    return;
  }

  if (request.method !== "POST") {
    throw new HttpError(405, "Method not allowed.");
  }

  requireAuth(request, options.apiKey);

  if (url.pathname === "/retrieval") {
    const body = await readJson(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const payload = await handleDifyRetrieval(body, loaded, storage, options);
    writeJson(response, 200, payload);
    return;
  }

  if (url.pathname === "/search") {
    const body = await readJson(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const payload = await handleGenericSearch(body, loaded, storage);
    writeJson(response, 200, payload);
    return;
  }

  throw new HttpError(404, "Endpoint not found.");
}

async function handleDifyRetrieval(
  body: unknown,
  loaded: LoadedConfig,
  storage: StorageAdapter,
  options: ServeOptions,
): Promise<JsonRecord> {
  const request = expectRecord(body, "request body");
  const knowledgeId = expectString(request.knowledge_id, "knowledge_id");
  if (options.knowledgeId && knowledgeId !== options.knowledgeId) {
    throw new HttpError(404, `Knowledge base not found: ${knowledgeId}`, 2001);
  }

  const query = expectString(request.query, "query");
  const retrievalSetting = expectRecord(request.retrieval_setting, "retrieval_setting");
  const k = parseTopK(retrievalSetting.top_k, "retrieval_setting.top_k");
  const scoreThreshold = parseScoreThreshold(
    retrievalSetting.score_threshold,
    "retrieval_setting.score_threshold",
  );
  const rowFilter = parseMetadataCondition(request.metadata_condition);

  const search = await searchForHttp(loaded, storage, {
    query,
    k,
    scoreThreshold,
    filters: {},
    rowFilter,
  });

  return {
    records: search.results.map(({ result, score }) => ({
      content: result.content,
      score,
      title: result.title ?? result.path,
      metadata: resultMetadata(result, score, search.retrieval_mode),
    })),
  };
}

async function handleGenericSearch(
  body: unknown,
  loaded: LoadedConfig,
  storage: StorageAdapter,
): Promise<JsonRecord> {
  const request = expectRecord(body, "request body");
  const query = expectString(request.query, "query");
  const k = parseTopK(request.k ?? request.top_k ?? DEFAULT_TOP_K, "k");
  const scoreThreshold = parseScoreThreshold(request.score_threshold ?? 0, "score_threshold");
  const filters = parseExactFilters(request.filters);
  const rowFilter = parseMetadataCondition(request.metadata_condition);

  const search = await searchForHttp(loaded, storage, {
    query,
    k,
    scoreThreshold,
    filters,
    rowFilter,
  });

  return {
    query,
    count: search.results.length,
    retrieval_mode: search.retrieval_mode,
    results: search.results.map(({ result, score }) => ({
      content: result.content,
      score,
      raw_score: result.score,
      title: result.title ?? result.path,
      path: result.path,
      slug: result.slug,
      heading_path: result.heading_path,
      snippet: result.snippet,
      evidence: result.evidence,
      metadata: resultMetadata(result, score, search.retrieval_mode),
    })),
    diagnostics: search.diagnostics,
  };
}

async function searchForHttp(
  loaded: LoadedConfig,
  storage: StorageAdapter,
  options: SearchForHttpOptions,
): Promise<{
  retrieval_mode: "hybrid" | "keyword_only";
  results: NormalizedResult[];
  diagnostics: JsonRecord;
}> {
  const internalK = Math.max(options.k * 4, options.k, 20);
  const response = await runChunkSearch(storage, loaded.config, options.query, {
    k: internalK,
    filters: options.filters,
    rowFilter: options.rowFilter,
    explain: true,
  });
  const normalized = normalizeScores(response.results)
    .filter((item) => item.score >= options.scoreThreshold)
    .slice(0, options.k);
  return {
    retrieval_mode: response.retrieval_mode,
    results: normalized,
    diagnostics: response.diagnostics,
  };
}

function normalizeScores(results: ChunkSearchResult[]): NormalizedResult[] {
  const maxScore = Math.max(...results.map((result) => result.score), 0);
  return results.map((result) => ({
    result,
    score: maxScore > 0 ? clamp(result.score / maxScore, 0, 1) : 0,
  }));
}

function resultMetadata(
  result: ChunkSearchResult,
  normalizedScore: number,
  retrievalMode: "hybrid" | "keyword_only",
): JsonRecord {
  return {
    path: result.path,
    slug: result.slug,
    chunk_uid: result.chunk_uid,
    doc_id: result.doc_id,
    seq: result.seq,
    heading_path: result.heading_path,
    token_est: result.token_est,
    content_hash: result.content_hash,
    evidence: result.evidence,
    tier: result.tier,
    facets: result.facets,
    status_flags: result.status_flags,
    retrieval_mode: retrievalMode,
    guzhi_score: result.score,
    normalized_score: normalizedScore,
  };
}

function parseExactFilters(value: unknown): Record<string, string> {
  if (value == null) return {};
  const record = expectRecord(value, "filters");
  const filters: Record<string, string> = {};
  for (const [key, filterValue] of Object.entries(record)) {
    if (filterValue == null || Array.isArray(filterValue) || typeof filterValue === "object") {
      throw new HttpError(400, `filters.${key} must be a scalar value.`);
    }
    filters[key] = String(filterValue);
  }
  return filters;
}

function parseMetadataCondition(value: unknown): ((row: ChunkRow) => boolean) | undefined {
  if (value == null) return undefined;
  const condition = expectRecord(value, "metadata_condition");
  const operator = String(condition.logical_operator ?? "and").toLowerCase();
  if (operator !== "and" && operator !== "or") {
    throw new HttpError(400, "metadata_condition.logical_operator must be 'and' or 'or'.");
  }
  const conditions = condition.conditions;
  if (!Array.isArray(conditions)) {
    throw new HttpError(400, "metadata_condition.conditions must be an array.");
  }
  const predicates = conditions.map((item, index) => metadataPredicate(item, index));
  return (row) => {
    if (operator === "or") return predicates.some((predicate) => predicate(row));
    return predicates.every((predicate) => predicate(row));
  };
}

function metadataPredicate(value: unknown, index: number): (row: ChunkRow) => boolean {
  const condition = expectRecord(value, `metadata_condition.conditions[${index}]`);
  const name = expectString(condition.name, `metadata_condition.conditions[${index}].name`);
  const operator = expectString(
    condition.comparison_operator,
    `metadata_condition.conditions[${index}].comparison_operator`,
  ).toLowerCase();
  validateMetadataConditionValue(condition, operator, index);

  return (row) => {
    const current = metadataValue(row, name);
    switch (operator) {
      case "contains":
        return containsValue(current, condition.value);
      case "not contains":
        return !containsValue(current, condition.value);
      case "start with":
        return typeof current === "string" && typeof condition.value === "string"
          ? current.startsWith(condition.value)
          : false;
      case "end with":
        return typeof current === "string" && typeof condition.value === "string"
          ? current.endsWith(condition.value)
          : false;
      case "is":
      case "=":
        return valuesEqual(current, condition.value);
      case "is not":
      case "!=":
      case "≠":
        return !valuesEqual(current, condition.value);
      case "in":
        return Array.isArray(condition.value)
          ? condition.value.some((candidate) => valuesEqual(current, candidate))
          : false;
      case "not in":
        return Array.isArray(condition.value)
          ? condition.value.every((candidate) => !valuesEqual(current, candidate))
          : true;
      case "empty":
        return isEmptyValue(current);
      case "not empty":
        return !isEmptyValue(current);
      case ">":
        return compareNumbers(current, condition.value, (a, b) => a > b);
      case "<":
        return compareNumbers(current, condition.value, (a, b) => a < b);
      case ">=":
      case "≥":
        return compareNumbers(current, condition.value, (a, b) => a >= b);
      case "<=":
      case "≤":
        return compareNumbers(current, condition.value, (a, b) => a <= b);
      case "before":
        return compareDates(current, condition.value, (a, b) => a < b);
      case "after":
        return compareDates(current, condition.value, (a, b) => a > b);
      default:
        return false;
    }
  };
}

function validateMetadataConditionValue(
  condition: Record<string, unknown>,
  operator: string,
  index: number,
): void {
  if (!SUPPORTED_METADATA_OPERATORS.has(operator)) {
    throw new HttpError(400, `Unsupported metadata comparison operator: ${operator}`);
  }
  const hasValue = Object.prototype.hasOwnProperty.call(condition, "value");
  if (VALUELESS_METADATA_OPERATORS.has(operator)) return;
  if (!hasValue) {
    throw new HttpError(400, `metadata_condition.conditions[${index}].value is required.`);
  }
  if (ARRAY_METADATA_OPERATORS.has(operator) && !Array.isArray(condition.value)) {
    throw new HttpError(400, `metadata_condition.conditions[${index}].value must be an array.`);
  }
}

function metadataValue(row: ChunkRow, name: string): unknown {
  const facets = jsonObject(row.facets);
  if (Object.prototype.hasOwnProperty.call(facets, name)) return facets[name];
  switch (name) {
    case "path":
      return row.path;
    case "slug":
      return row.slug;
    case "title":
      return row.title;
    case "doc_id":
      return row.doc_id;
    case "chunk_uid":
      return row.chunk_uid;
    case "seq":
      return row.seq;
    case "tier":
      return row.tier;
    default:
      return undefined;
  }
}

function containsValue(current: unknown, expected: unknown): boolean {
  if (Array.isArray(current)) return current.some((item) => valuesEqual(item, expected));
  if (typeof current === "string") return typeof expected === "string" && current.includes(expected);
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" || typeof right === "number") {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
  }
  return String(left) === String(right);
}

function compareNumbers(
  left: unknown,
  right: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && compare(leftNumber, rightNumber);
}

function compareDates(
  left: unknown,
  right: unknown,
  compare: (a: number, b: number) => boolean,
): boolean {
  const leftTime = Date.parse(String(left));
  const rightTime = Date.parse(String(right));
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && compare(leftTime, rightTime);
}

function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function requireAuth(request: IncomingMessage, apiKey?: string): void {
  if (!apiKey) return;
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new HttpError(401, "Invalid Authorization header format.", 1001);
  }
  if (header.slice("Bearer ".length) !== apiKey) {
    throw new HttpError(401, "Authorization failed. Please check your API key.", 1002);
  }
}

async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const body = await readBody(request, maxBodyBytes);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
        reject(new HttpError(413, "Request body too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${name} must be a non-empty string.`);
  }
  return value;
}

function parseTopK(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TOP_K) {
    throw new HttpError(400, `${name} must be an integer from 1 to ${MAX_TOP_K}.`);
  }
  return parsed;
}

function parseScoreThreshold(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new HttpError(400, `${name} must be a number from 0 to 1.`);
  }
  return parsed;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (status === 204 || value == null) {
    response.end();
    return;
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(response: ServerResponse, error: unknown, difyShape: boolean): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof GuzhiError && error.kind === "config"
        ? 400
        : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (difyShape) {
    writeJson(response, status, {
      error_code: error instanceof HttpError && error.errorCode ? error.errorCode : status,
      error_msg: message,
    });
    return;
  }
  writeJson(response, status, {
    error: {
      message,
      status,
    },
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function isDifyPath(url: string | undefined): boolean {
  return new URL(url ?? "/", "http://localhost").pathname === "/retrieval";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
