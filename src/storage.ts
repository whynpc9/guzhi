import { mkdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type {
  ChunkRow,
  DocumentRow,
  ExtractedLink,
  JsonRecord,
  ParsedDocument,
  WenguConfig,
} from "./types.js";
import { WenguError } from "./types.js";
import { cosineSimilarity, jsonArray, jsonObject, newId, parseVector, sha256 } from "./util.js";

interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
}

export interface Stats {
  documents_active: number;
  documents_deleted: number;
  chunks: number;
  links: number;
  broken_links: number;
  ambiguous_links: number;
  queued_embeddings: number;
  failed_embeddings: number;
  embedded_chunks: number;
  retrieval_mode: "hybrid" | "keyword_only";
  last_sync: unknown;
  embedding_fingerprint: unknown;
}

export interface QueuedChunk {
  chunk_uid: string;
  content_hash: string;
  body: string;
  token_est: number;
}

export interface LinkRow {
  id: number;
  src_doc_id: string;
  src_path: string;
  kind: string;
  raw_target: string;
  normalized_target: string;
  anchor: string | null;
  alias: string | null;
  resolved_doc_id: string | null;
  resolved_path: string | null;
  ambiguous: boolean;
}

export class PgliteStorage {
  private constructor(private readonly db: PGlite) {}

  static async open(config: WenguConfig): Promise<PgliteStorage> {
    await mkdir(path.dirname(config.storage.data_dir), { recursive: true });
    const db = new PGlite(config.storage.data_dir);
    await db.waitReady;
    const storage = new PgliteStorage(db);
    await storage.migrate();
    return storage;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async migrate(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        doc_id text PRIMARY KEY,
        path text UNIQUE NOT NULL,
        slug text NOT NULL,
        concept_id text NOT NULL,
        title text,
        type text,
        description text,
        tags jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_ts text,
        updated_ts text,
        facets jsonb NOT NULL DEFAULT '{}'::jsonb,
        frontmatter_raw jsonb NOT NULL DEFAULT '{}'::jsonb,
        content_hash text NOT NULL,
        frontmatter_hash text NOT NULL,
        size_bytes bigint NOT NULL,
        file_mtime double precision NOT NULL,
        tier double precision NOT NULL DEFAULT 1,
        reserved boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'active',
        diag_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
        last_synced_at text NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_uid text PRIMARY KEY,
        doc_id text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        seq integer NOT NULL,
        heading_path jsonb NOT NULL DEFAULT '[]'::jsonb,
        anchor text,
        body text NOT NULL,
        token_est integer NOT NULL,
        content_hash text NOT NULL,
        embedding jsonb,
        flags jsonb NOT NULL DEFAULT '[]'::jsonb
      );

      CREATE TABLE IF NOT EXISTS links (
        id bigserial PRIMARY KEY,
        src_doc_id text NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        kind text NOT NULL,
        raw_target text NOT NULL,
        normalized_target text NOT NULL,
        anchor text,
        alias text,
        resolved_doc_id text REFERENCES documents(doc_id) ON DELETE SET NULL,
        ambiguous boolean NOT NULL DEFAULT false
      );

      CREATE TABLE IF NOT EXISTS embedding_cache (
        provider text NOT NULL,
        model text NOT NULL,
        dimensions integer NOT NULL,
        content_hash text NOT NULL,
        vector jsonb NOT NULL,
        PRIMARY KEY (provider, model, dimensions, content_hash)
      );

      CREATE TABLE IF NOT EXISTS embed_queue (
        chunk_uid text PRIMARY KEY REFERENCES chunks(chunk_uid) ON DELETE CASCADE,
        enqueued_at text NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        retryable boolean
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id text PRIMARY KEY,
        started_at text NOT NULL,
        finished_at text,
        status text NOT NULL,
        plan_summary jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
      CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
      CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_links_src_doc_id ON links(src_doc_id);
      CREATE INDEX IF NOT EXISTS idx_links_resolved_doc_id ON links(resolved_doc_id);
      CREATE INDEX IF NOT EXISTS idx_links_normalized_target ON links(normalized_target);
    `);
    await this.setState("schema_version", { version: 1 });
  }

  async resetIndex(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("DELETE FROM embed_queue");
      await tx.query("DELETE FROM links");
      await tx.query("DELETE FROM chunks");
      await tx.query("DELETE FROM documents");
    });
  }

  async getState<T = unknown>(key: string): Promise<T | null> {
    const result = await this.db.query<{ value: T }>("SELECT value FROM sync_state WHERE key = $1", [key]);
    return result.rows[0]?.value ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `
      INSERT INTO sync_state(key, value)
      VALUES ($1, $2::jsonb)
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
      `,
      [key, JSON.stringify(value)],
    );
  }

  async startRun(runId: string, startedAt: string): Promise<void> {
    await this.db.query(
      "INSERT INTO sync_runs(run_id, started_at, status) VALUES ($1, $2, 'running')",
      [runId, startedAt],
    );
  }

  async finishRun(runId: string, status: string, planSummary: unknown): Promise<void> {
    await this.db.query(
      "UPDATE sync_runs SET finished_at = $2, status = $3, plan_summary = $4::jsonb WHERE run_id = $1",
      [runId, new Date().toISOString(), status, JSON.stringify(planSummary)],
    );
  }

  async listActiveDocuments(): Promise<DocumentRow[]> {
    const result = await this.db.query<DocumentRow>(
      "SELECT * FROM documents WHERE status = 'active' ORDER BY path",
    );
    return result.rows;
  }

  async getDocumentByPath(filePath: string): Promise<DocumentRow | null> {
    const result = await this.db.query<DocumentRow>("SELECT * FROM documents WHERE path = $1", [filePath]);
    return result.rows[0] ?? null;
  }

  async upsertDocument(doc: ParsedDocument, embedConfig: WenguConfig["embedding"]): Promise<string> {
    const existing = await this.getDocumentByPath(doc.path);
    const docId = existing?.doc_id ?? newId();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `
        INSERT INTO documents (
          doc_id, path, slug, concept_id, title, type, description, tags,
          created_ts, updated_ts, facets, frontmatter_raw, content_hash,
          frontmatter_hash, size_bytes, file_mtime, tier, reserved, status,
          diag_flags, last_synced_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb,
          $9, $10, $11::jsonb, $12::jsonb, $13,
          $14, $15, $16, $17, $18, 'active',
          $19::jsonb, $20
        )
        ON CONFLICT(path) DO UPDATE SET
          slug = EXCLUDED.slug,
          concept_id = EXCLUDED.concept_id,
          title = EXCLUDED.title,
          type = EXCLUDED.type,
          description = EXCLUDED.description,
          tags = EXCLUDED.tags,
          created_ts = EXCLUDED.created_ts,
          updated_ts = EXCLUDED.updated_ts,
          facets = EXCLUDED.facets,
          frontmatter_raw = EXCLUDED.frontmatter_raw,
          content_hash = EXCLUDED.content_hash,
          frontmatter_hash = EXCLUDED.frontmatter_hash,
          size_bytes = EXCLUDED.size_bytes,
          file_mtime = EXCLUDED.file_mtime,
          tier = EXCLUDED.tier,
          reserved = EXCLUDED.reserved,
          status = 'active',
          diag_flags = EXCLUDED.diag_flags,
          last_synced_at = EXCLUDED.last_synced_at
        `,
        [
          docId,
          doc.path,
          doc.slug,
          doc.conceptId,
          doc.title,
          doc.type,
          doc.description,
          JSON.stringify(doc.tags),
          doc.createdTs,
          doc.updatedTs,
          JSON.stringify(doc.facets),
          JSON.stringify(doc.frontmatterRaw),
          doc.contentHash,
          doc.frontmatterHash,
          doc.sizeBytes,
          doc.fileMtime,
          doc.tier,
          doc.reserved,
          JSON.stringify(doc.diagnostics.map((diag) => diag.kind)),
          new Date().toISOString(),
        ],
      );
      await this.replaceChunksInTransaction(tx, docId, doc, embedConfig);
      await this.replaceLinksInTransaction(tx, docId, doc.links);
    });
    return docId;
  }

  async tombstoneDocument(filePath: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE documents SET status = 'deleted', last_synced_at = $2 WHERE path = $1 AND status <> 'deleted'",
      [filePath, new Date().toISOString()],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  async refreshAllLinkResolutions(): Promise<void> {
    const docs = await this.listActiveDocuments();
    const pathMap = new Map(docs.map((doc) => [doc.path, doc]));
    const slugMap = new Map<string, DocumentRow[]>();
    for (const doc of docs) {
      const bucket = slugMap.get(doc.slug) ?? [];
      bucket.push(doc);
      slugMap.set(doc.slug, bucket);
    }
    const links = await this.db.query<{
      id: number;
      kind: string;
      normalized_target: string;
    }>("SELECT id, kind, normalized_target FROM links ORDER BY id");

    await this.db.transaction(async (tx) => {
      for (const link of links.rows) {
        const resolution = resolveLink(link.kind, link.normalized_target, pathMap, slugMap);
        await tx.query("UPDATE links SET resolved_doc_id = $2, ambiguous = $3 WHERE id = $1", [
          link.id,
          resolution.docId,
          resolution.ambiguous,
        ]);
      }
    });
  }

  async getStats(): Promise<Stats> {
    const [
      active,
      deleted,
      chunks,
      links,
      broken,
      ambiguous,
      queued,
      failed,
      embedded,
      lastSync,
      fingerprint,
    ] = await Promise.all([
      this.count("SELECT count(*)::int AS count FROM documents WHERE status = 'active'"),
      this.count("SELECT count(*)::int AS count FROM documents WHERE status = 'deleted'"),
      this.count("SELECT count(*)::int AS count FROM chunks"),
      this.count("SELECT count(*)::int AS count FROM links"),
      this.count(
        "SELECT count(*)::int AS count FROM links WHERE kind <> 'external' AND resolved_doc_id IS NULL",
      ),
      this.count("SELECT count(*)::int AS count FROM links WHERE ambiguous = true"),
      this.count("SELECT count(*)::int AS count FROM embed_queue WHERE last_error IS NULL"),
      this.count("SELECT count(*)::int AS count FROM embed_queue WHERE last_error IS NOT NULL"),
      this.count("SELECT count(*)::int AS count FROM chunks WHERE embedding IS NOT NULL"),
      this.getState("last_sync"),
      this.getState("embedding_fingerprint"),
    ]);
    return {
      documents_active: active,
      documents_deleted: deleted,
      chunks,
      links,
      broken_links: broken,
      ambiguous_links: ambiguous,
      queued_embeddings: queued,
      failed_embeddings: failed,
      embedded_chunks: embedded,
      retrieval_mode: embedded > 0 ? "hybrid" : "keyword_only",
      last_sync: lastSync,
      embedding_fingerprint: fingerprint,
    };
  }

  async listQueuedChunks(limit: number): Promise<QueuedChunk[]> {
    const result = await this.db.query<QueuedChunk>(
      `
      SELECT q.chunk_uid, c.content_hash, c.body, c.token_est
      FROM embed_queue q
      JOIN chunks c ON c.chunk_uid = q.chunk_uid
      WHERE q.retryable IS DISTINCT FROM false
      ORDER BY q.enqueued_at, q.attempts
      LIMIT $1
      `,
      [limit],
    );
    return result.rows;
  }

  async fulfillEmbedding(
    chunkUid: string,
    contentHash: string,
    vector: number[],
    config: WenguConfig["embedding"],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `
        INSERT INTO embedding_cache(provider, model, dimensions, content_hash, vector)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT(provider, model, dimensions, content_hash)
        DO UPDATE SET vector = EXCLUDED.vector
        `,
        [config.provider, config.model, vector.length, contentHash, JSON.stringify(vector)],
      );
      await tx.query("UPDATE chunks SET embedding = $2::jsonb WHERE chunk_uid = $1", [
        chunkUid,
        JSON.stringify(vector),
      ]);
      await tx.query("DELETE FROM embed_queue WHERE chunk_uid = $1", [chunkUid]);
    });
  }

  async markEmbeddingFailure(chunkUid: string, error: string, retryable: boolean): Promise<void> {
    await this.db.query(
      `
      UPDATE embed_queue
      SET attempts = attempts + 1, last_error = $2, retryable = $3
      WHERE chunk_uid = $1
      `,
      [chunkUid, error.slice(0, 2000), retryable],
    );
  }

  async retryFailedEmbeddings(): Promise<number> {
    const result = await this.db.query(
      `
      UPDATE embed_queue
      SET attempts = 0, last_error = NULL, retryable = NULL
      WHERE retryable = true OR last_error LIKE '%maximum context length%'
      `,
    );
    return result.affectedRows ?? 0;
  }

  async enqueueMissingEmbeddings(): Promise<number> {
    const result = await this.db.query(
      `
      INSERT INTO embed_queue(chunk_uid, enqueued_at)
      SELECT c.chunk_uid, $1
      FROM chunks c
      JOIN documents d ON d.doc_id = c.doc_id
      WHERE d.status = 'active' AND c.embedding IS NULL
      ON CONFLICT(chunk_uid) DO NOTHING
      `,
      [new Date().toISOString()],
    );
    return result.affectedRows ?? 0;
  }

  async listFailedEmbeddings(limit: number): Promise<
    Array<{
      chunk_uid: string;
      path: string;
      attempts: number;
      last_error: string | null;
      retryable: boolean | null;
    }>
  > {
    const result = await this.db.query<{
      chunk_uid: string;
      path: string;
      attempts: number;
      last_error: string | null;
      retryable: boolean | null;
    }>(
      `
      SELECT q.chunk_uid, d.path, q.attempts, q.last_error, q.retryable
      FROM embed_queue q
      JOIN chunks c ON c.chunk_uid = q.chunk_uid
      JOIN documents d ON d.doc_id = c.doc_id
      WHERE q.last_error IS NOT NULL
      ORDER BY q.retryable DESC NULLS LAST, q.attempts DESC, d.path
      LIMIT $1
      `,
      [limit],
    );
    return result.rows;
  }

  async setEmbeddingFingerprint(config: WenguConfig["embedding"], dimensions: number): Promise<void> {
    await this.setState("embedding_fingerprint", {
      provider: config.provider,
      model: config.model,
      dimensions,
    });
  }

  async fetchSearchCorpus(filters: Record<string, string>): Promise<ChunkRow[]> {
    const result = await this.db.query<ChunkRow>(
      `
      SELECT
        c.chunk_uid,
        c.doc_id,
        d.path,
        d.slug,
        d.title,
        c.seq,
        c.heading_path,
        c.body,
        c.token_est,
        c.content_hash,
        c.embedding,
        d.tier,
        d.facets,
        c.flags
      FROM chunks c
      JOIN documents d ON d.doc_id = c.doc_id
      WHERE d.status = 'active'
      `,
    );
    return result.rows.filter((row) => rowMatchesFilters(row, filters));
  }

  async resolveSlug(slugOrPath: string): Promise<DocumentRow[]> {
    const result = await this.db.query<DocumentRow>(
      `
      SELECT * FROM documents
      WHERE status = 'active' AND (slug = $1 OR path = $1 OR path = $2)
      ORDER BY path
      `,
      [slugOrPath, slugOrPath.endsWith(".md") ? slugOrPath : `${slugOrPath}.md`],
    );
    return result.rows;
  }

  async findDocument(slugOrPath: string): Promise<DocumentRow | null> {
    const rows = await this.resolveSlug(slugOrPath);
    return rows[0] ?? null;
  }

  async listLinksFor(docId: string): Promise<{
    outgoing: LinkRow[];
    incoming: LinkRow[];
    broken: LinkRow[];
  }> {
    const outgoing = await this.db.query<LinkRow>(
      `
      SELECT l.*, sd.path AS src_path, rd.path AS resolved_path
      FROM links l
      JOIN documents sd ON sd.doc_id = l.src_doc_id
      LEFT JOIN documents rd ON rd.doc_id = l.resolved_doc_id
      WHERE l.src_doc_id = $1
      ORDER BY l.kind, l.normalized_target
      `,
      [docId],
    );
    const incoming = await this.db.query<LinkRow>(
      `
      SELECT l.*, sd.path AS src_path, rd.path AS resolved_path
      FROM links l
      JOIN documents sd ON sd.doc_id = l.src_doc_id
      LEFT JOIN documents rd ON rd.doc_id = l.resolved_doc_id
      WHERE l.resolved_doc_id = $1
      ORDER BY sd.path
      `,
      [docId],
    );
    const broken = await this.db.query<LinkRow>(
      `
      SELECT l.*, sd.path AS src_path, rd.path AS resolved_path
      FROM links l
      JOIN documents sd ON sd.doc_id = l.src_doc_id
      LEFT JOIN documents rd ON rd.doc_id = l.resolved_doc_id
      WHERE l.src_doc_id = $1 AND l.kind <> 'external' AND l.resolved_doc_id IS NULL
      ORDER BY l.normalized_target
      `,
      [docId],
    );
    return { outgoing: outgoing.rows, incoming: incoming.rows, broken: broken.rows };
  }

  scoreVectors(rows: ChunkRow[], queryVector: number[]): Map<string, number> {
    const scores = new Map<string, number>();
    for (const row of rows) {
      const vector = parseVector(row.embedding);
      if (!vector) continue;
      const score = cosineSimilarity(queryVector, vector);
      if (score > 0) scores.set(row.chunk_uid, score);
    }
    return scores;
  }

  private async replaceChunksInTransaction(
    tx: Queryable,
    docId: string,
    doc: ParsedDocument,
    embedConfig: WenguConfig["embedding"],
  ): Promise<void> {
    await tx.query("DELETE FROM chunks WHERE doc_id = $1", [docId]);
    for (const chunk of doc.chunks) {
      const chunkUid = sha256(`${docId}:${chunk.anchor ?? ""}:${chunk.seq}:${chunk.contentHash}`);
      const cached = await this.lookupCachedEmbedding(tx, chunk.contentHash, embedConfig);
      await tx.query(
        `
        INSERT INTO chunks (
          chunk_uid, doc_id, seq, heading_path, anchor, body, token_est,
          content_hash, embedding, flags
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
        `,
        [
          chunkUid,
          docId,
          chunk.seq,
          JSON.stringify(chunk.headingPath),
          chunk.anchor,
          chunk.body,
          chunk.tokenEstimate,
          chunk.contentHash,
          cached ? JSON.stringify(cached) : null,
          JSON.stringify(chunk.flags),
        ],
      );
      if (embedConfig.provider !== "none" && !cached) {
        await tx.query(
          `
          INSERT INTO embed_queue(chunk_uid, enqueued_at)
          VALUES ($1, $2)
          ON CONFLICT(chunk_uid) DO NOTHING
          `,
          [chunkUid, new Date().toISOString()],
        );
      }
    }
  }

  private async replaceLinksInTransaction(
    tx: Queryable,
    docId: string,
    links: ExtractedLink[],
  ): Promise<void> {
    await tx.query("DELETE FROM links WHERE src_doc_id = $1", [docId]);
    for (const link of links) {
      await tx.query(
        `
        INSERT INTO links (
          src_doc_id, kind, raw_target, normalized_target, anchor, alias
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [docId, link.kind, link.rawTarget, link.normalizedTarget, link.anchor, link.alias],
      );
    }
  }

  private async lookupCachedEmbedding(
    queryable: Queryable,
    contentHash: string,
    config: WenguConfig["embedding"],
  ): Promise<number[] | null> {
    if (config.provider === "none") return null;
    const result = await queryable.query<{ vector: unknown }>(
      `
      SELECT vector
      FROM embedding_cache
      WHERE provider = $1 AND model = $2 AND content_hash = $3
      ORDER BY dimensions DESC
      LIMIT 1
      `,
      [config.provider, config.model, contentHash],
    );
    return parseVector(result.rows[0]?.vector);
  }

  private async count(sql: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(sql);
    return Number(result.rows[0]?.count ?? 0);
  }
}

function resolveLink(
  kind: string,
  normalizedTarget: string,
  pathMap: Map<string, DocumentRow>,
  slugMap: Map<string, DocumentRow[]>,
): { docId: string | null; ambiguous: boolean } {
  if (kind === "external") return { docId: null, ambiguous: false };
  if (kind === "mdlink_absolute" || kind === "mdlink_relative" || kind === "footnote_source") {
    const byPath = pathMap.get(normalizedTarget);
    return { docId: byPath?.doc_id ?? null, ambiguous: false };
  }
  const pathCandidates = [
    normalizedTarget,
    normalizedTarget.endsWith(".md") ? normalizedTarget : `${normalizedTarget}.md`,
  ];
  for (const candidate of pathCandidates) {
    const byPath = pathMap.get(candidate);
    if (byPath) return { docId: byPath.doc_id, ambiguous: false };
  }
  const slug = normalizedTarget.split("/").pop() ?? normalizedTarget;
  const bySlug = slugMap.get(slug) ?? [];
  if (bySlug.length === 1) return { docId: bySlug[0].doc_id, ambiguous: false };
  if (bySlug.length > 1) return { docId: null, ambiguous: true };
  return { docId: null, ambiguous: false };
}

function rowMatchesFilters(row: ChunkRow, filters: Record<string, string>): boolean {
  const facets = jsonObject(row.facets);
  for (const [key, expected] of Object.entries(filters)) {
    const value = facets[key];
    if (String(value) !== expected) return false;
  }
  return true;
}

export function deserializeHeadingPath(value: unknown): string[] {
  return jsonArray(value).map(String);
}

export function deserializeFlags(value: unknown): string[] {
  return jsonArray(value).map(String);
}

export function deserializeFacets(value: unknown): JsonRecord {
  return jsonObject(value);
}
