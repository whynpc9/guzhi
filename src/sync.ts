import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { discoverMarkdownFiles } from "./discovery.js";
import { processEmbeddingQueue, throwIfEmbeddingConfigDrift } from "./embedding.js";
import { withSyncLock } from "./lock.js";
import { parseMarkdownDocument } from "./markdown.js";
import type { LoadedConfig, WenguConfig } from "./types.js";
import { WenguError } from "./types.js";
import { PgliteStorage } from "./storage.js";
import { newId, writeJsonAtomic } from "./util.js";

export interface SyncOptions {
  full?: boolean;
  noEmbed?: boolean;
  retryFailed?: boolean;
  dryRun?: boolean;
  breakLock?: boolean;
  embedLimit?: number;
  maxFiles?: number;
}

export interface SyncSummary {
  run_id: string;
  status: "success" | "partial" | "dry_run";
  discovered: number;
  indexed: number;
  skipped: number;
  tombstoned: number;
  excluded: number;
  diagnostics: number;
  embeddings: {
    attempted: number;
    succeeded: number;
    failed: number;
    remaining: number;
    dimensions: number | null;
  };
}

export async function runSync(loaded: LoadedConfig, options: SyncOptions): Promise<SyncSummary> {
  const { config } = loaded;
  await mkdir(path.dirname(config.storage.data_dir), { recursive: true });
  return withSyncLock(config, { breakLock: options.breakLock }, async () => {
    const storage = await PgliteStorage.open(config);
    const runId = newId();
    const startedAt = new Date().toISOString();
    const journalPath = path.join(path.dirname(config.storage.data_dir), "journal", `${runId}.json`);
    const summary: SyncSummary = {
      run_id: runId,
      status: options.dryRun ? "dry_run" : "success",
      discovered: 0,
      indexed: 0,
      skipped: 0,
      tombstoned: 0,
      excluded: 0,
      diagnostics: 0,
      embeddings: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        remaining: 0,
        dimensions: null,
      },
    };

    try {
      throwIfEmbeddingConfigDrift((await storage.getStats()).embedding_fingerprint, config.embedding);
      if (options.retryFailed) {
        await storage.retryFailedEmbeddings();
      }
      if (!options.dryRun) {
        await storage.startRun(runId, startedAt);
      }

      const discovered = await discoverMarkdownFiles(config);
      const limited = options.maxFiles ? discovered.slice(0, options.maxFiles) : discovered;
      summary.discovered = discovered.length;
      await writeJsonAtomic(journalPath, { run_id: runId, started_at: startedAt, discovered: discovered.length });

      if (options.full && !options.dryRun) {
        await storage.resetIndex();
      }

      const activeBefore = await storage.listActiveDocuments();
      const discoveredSet = new Set(discovered.map((file) => file.path));
      const existingByPath = new Map(activeBefore.map((doc) => [doc.path, doc]));

      for (const doc of activeBefore) {
        if (discoveredSet.has(doc.path)) continue;
        if (await fileStillExists(config, doc.path)) continue;
        summary.tombstoned += 1;
        if (!options.dryRun) {
          await storage.tombstoneDocument(doc.path);
        }
      }

      for (const file of limited) {
        const parsed = await parseMarkdownDocument(file.path, file.absolutePath, config);
        summary.diagnostics += parsed.diagnostics.length;
        if (parsed.excluded) {
          summary.excluded += 1;
          if (!options.dryRun) await storage.tombstoneDocument(parsed.path);
          continue;
        }
        const existing = existingByPath.get(parsed.path);
        if (
          existing &&
          existing.status === "active" &&
          existing.content_hash === parsed.contentHash &&
          existing.frontmatter_hash === parsed.frontmatterHash
        ) {
          summary.skipped += 1;
          continue;
        }
        summary.indexed += 1;
        if (!options.dryRun) {
          await storage.upsertDocument(
            parsed,
            options.noEmbed ? { ...config.embedding, provider: "none" } : config.embedding,
          );
        }
      }

      if (!options.dryRun) {
        await storage.refreshAllLinkResolutions();
        if (!options.noEmbed) {
          await storage.enqueueMissingEmbeddings();
          summary.embeddings = await processEmbeddingQueue(storage, config, { limit: options.embedLimit });
        } else {
          const stats = await storage.getStats();
          summary.embeddings.remaining = stats.queued_embeddings + stats.failed_embeddings;
        }
        await storage.setState("last_sync", {
          run_id: runId,
          finished_at: new Date().toISOString(),
          repo_root: config.repo.root,
          status: summary.status,
        });
        await storage.finishRun(runId, summary.status, summary);
      }
      await writeJsonAtomic(journalPath, summary);
      return summary;
    } catch (error) {
      if (!options.dryRun) {
        await storage.finishRun(runId, "failed", {
          error: error instanceof Error ? error.message : String(error),
          summary,
        }).catch(() => undefined);
      }
      throw classifySyncError(error);
    } finally {
      await storage.close();
    }
  });
}

async function fileStillExists(config: WenguConfig, relativePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(path.resolve(config.repo.root, relativePath));
    return fileStat.isFile();
  } catch (error) {
    if (isEnoent(error)) return false;
    throw new WenguError(
      "transient",
      `Could not verify deletion candidate ${relativePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "Fix the filesystem error and rerun `wengu sync`.",
    );
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function classifySyncError(error: unknown): Error {
  if (error instanceof WenguError) return error;
  return new WenguError("transient", error instanceof Error ? error.message : String(error));
}
