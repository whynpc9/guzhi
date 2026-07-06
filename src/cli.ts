#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { Command } from "commander";
import { configForDisplay, loadConfig, writeInitialConfig } from "./config.js";
import { checkEmbeddingProvider } from "./embedding.js";
import { touchProjectGitignore } from "./lock.js";
import { runSearch } from "./search.js";
import { installSkill } from "./skill.js";
import { openStorage } from "./storage.js";
import { WenguError } from "./types.js";
import { runSync } from "./sync.js";

const program = new Command();

program
  .name("wengu")
  .description("Repo-local RAG infrastructure CLI for Markdown wiki repositories.")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to wengu.toml")
  .option("--repo <path>", "Markdown wiki root override")
  .option("--data-dir <path>", "Local data directory override for PGlite catalog, locks, and journals")
  .option("--storage-backend <backend>", "pglite | postgres | milvus")
  .option("--storage-url <url>", "Postgres connection URL")
  .option("--catalog-backend <backend>", "Catalog backend for milvus: pglite | postgres")
  .option("--milvus-address <address>", "Milvus gRPC address, for example localhost:19530")
  .option("--milvus-collection <name>", "Milvus collection name")
  .option("--embedding-provider <provider>", "openai-compatible | none")
  .option("--embedding-base-url <url>", "OpenAI-compatible embeddings endpoint")
  .option("--embedding-model <model>", "Embedding model name")
  .option("--embedding-dimensions <n>", "Expected embedding dimensions", parsePositiveInteger)
  .option("--search-mode <mode>", "hybrid | keyword | vector")
  .option("--json", "Emit JSON output");

program
  .command("init")
  .description("Create wengu.toml, .wengu/, .gitignore entry, and initialize the configured storage schema.")
  .option("--force", "Overwrite existing config")
  .action(async (options) => {
    await handle(async () => {
      const globals = globalOptions();
      const configPath = globals.configPath ?? "wengu.toml";
      if (!options.force && (await exists(configPath))) {
        throw new WenguError("config", `Config already exists: ${configPath}`, "Use `wengu init --force` to overwrite it.");
      }
      const config = await writeInitialConfig(process.cwd(), configPath, globals);
      await mkdir(config.storage.data_dir, { recursive: true });
      await touchProjectGitignore(process.cwd());
      const loaded = await loadConfig({ cwd: process.cwd(), ...globals, configPath });
      const storage = await openStorage(loaded.config);
      await storage.close();
      return {
        config_path: configPath,
        repo_root: config.repo.root,
        data_dir: config.storage.data_dir,
      };
    });
  });

program
  .command("sync")
  .description("Synchronize Markdown files into the derived retrieval index.")
  .option("--full", "Drop and rebuild the derived index")
  .option("--no-embed", "Skip embedding for this run")
  .option("--retry-failed", "Reset retryable embedding failures before processing")
  .option("--dry-run", "Only compute the diff plan")
  .option("--break-lock", "Remove a stale sync lock before starting")
  .option("--embed-limit <n>", "Process at most N queued chunks for embeddings", parsePositiveInteger)
  .option("--max-files <n>", "Development/testing guard: process at most N discovered files", parsePositiveInteger)
  .action(async (options) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      return runSync(loaded, {
        full: options.full,
        noEmbed: options.embed === false,
        retryFailed: options.retryFailed,
        dryRun: options.dryRun,
        breakLock: options.breakLock,
        embedLimit: options.embedLimit,
        maxFiles: options.maxFiles,
      });
    });
  });

program
  .command("status")
  .description("Show index state and embedding queue health.")
  .option("--failed", "List failed embedding queue rows")
  .option("--limit <n>", "Rows to show with --failed", parsePositiveInteger, 20)
  .action(async (options) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const storage = await openStorage(loaded.config);
      try {
        const stats = await storage.getStats();
        if (options.failed) {
          return { ...stats, failed_rows: await storage.listFailedEmbeddings(options.limit) };
        }
        return stats;
      } finally {
        await storage.close();
      }
    });
  });

const configCommand = program.command("config").description("Configuration commands.");
configCommand
  .command("show")
  .description("Show merged effective config and value sources.")
  .action(async () => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      return configForDisplay(loaded);
    });
  });

program
  .command("search")
  .description("Search the Markdown retrieval index.")
  .argument("<query>", "Search query")
  .option("-k, --k <n>", "Number of document results", parsePositiveInteger, 10)
  .option("--filter <key=value>", "Facet filter; repeatable", collect, [])
  .option("--explain", "Include score components")
  .action(async (query, options) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const storage = await openStorage(loaded.config);
      try {
        return await runSearch(storage, loaded.config, query, {
          k: options.k,
          filters: parseFilters(options.filter),
          explain: options.explain,
        });
      } finally {
        await storage.close();
      }
    });
  });

program
  .command("resolve")
  .description("Resolve a slug or repo-relative path to indexed documents.")
  .argument("<slug-or-path>")
  .action(async (slugOrPath) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const storage = await openStorage(loaded.config);
      try {
        const rows = await storage.resolveSlug(slugOrPath);
        return { query: slugOrPath, count: rows.length, results: rows };
      } finally {
        await storage.close();
      }
    });
  });

program
  .command("links")
  .description("Show outgoing links, backlinks, and broken links for a document.")
  .argument("<slug-or-path>")
  .action(async (slugOrPath) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const storage = await openStorage(loaded.config);
      try {
        const doc = await storage.findDocument(slugOrPath);
        if (!doc) throw new WenguError("config", `No active document found for ${slugOrPath}.`);
        return {
          document: { path: doc.path, slug: doc.slug, title: doc.title },
          ...(await storage.listLinksFor(doc.doc_id)),
        };
      } finally {
        await storage.close();
      }
    });
  });

program
  .command("doctor")
  .description("Check config, storage schema, queue health, and optionally embedding provider reachability.")
  .option("--check-embedding", "Call the configured embedding provider once")
  .action(async (options) => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const storage = await openStorage(loaded.config);
      try {
        const stats = await storage.getStats();
        const embedding = options.checkEmbedding
          ? await checkEmbeddingProvider(loaded.config)
          : { ok: true, message: "Skipped provider check. Use --check-embedding to call it." };
        return {
          ok: embedding.ok,
          repo_root: loaded.config.repo.root,
          data_dir: loaded.config.storage.data_dir,
          stats,
          embedding,
        };
      } finally {
        await storage.close();
      }
    });
  });

program
  .command("skill")
  .description("Skill commands.")
  .command("install")
  .description("Install a wengu-retrieval skill into the target repo.")
  .action(async () => {
    await handle(async () => {
      const loaded = await loadConfig({ cwd: process.cwd(), ...globalOptions() });
      const skill_path = await installSkill(loaded.config);
      return { skill_path };
    });
  });

program.parseAsync().catch((error) => {
  emitError(error);
});

function globalOptions() {
  const opts = program.opts();
  return {
    configPath: opts.config as string | undefined,
    repoRoot: opts.repo as string | undefined,
    dataDir: opts.dataDir as string | undefined,
    storageBackend: opts.storageBackend as "pglite" | "postgres" | "milvus" | undefined,
    storageUrl: opts.storageUrl as string | undefined,
    catalogBackend: opts.catalogBackend as "pglite" | "postgres" | undefined,
    milvusAddress: opts.milvusAddress as string | undefined,
    milvusCollection: opts.milvusCollection as string | undefined,
    embeddingProvider: opts.embeddingProvider as "openai-compatible" | "none" | undefined,
    embeddingBaseUrl: opts.embeddingBaseUrl as string | undefined,
    embeddingModel: opts.embeddingModel as string | undefined,
    embeddingDimensions: opts.embeddingDimensions as number | undefined,
    searchMode: opts.searchMode as "hybrid" | "keyword" | "vector" | undefined,
  };
}

async function handle(callback: () => Promise<unknown>): Promise<void> {
  try {
    const result = await callback();
    emit(result);
  } catch (error) {
    emitError(error);
  }
}

function emit(value: unknown): void {
  if (program.opts().json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(formatHuman(value));
}

function emitError(error: unknown): void {
  const kind = error instanceof WenguError ? error.kind : "transient";
  const message = error instanceof Error ? error.message : String(error);
  const fixHint = error instanceof WenguError ? error.fixHint : undefined;
  const payload = { error: { kind, message, fix_hint: fixHint } };
  if (program.opts().json) {
    console.error(
      JSON.stringify(
        process.env.WENGU_DEBUG === "1" && error instanceof Error
          ? { ...payload, stack: error.stack }
          : payload,
        null,
        2,
      ),
    );
  } else {
    console.error(`${kind}: ${message}${fixHint ? `\nfix: ${fixHint}` : ""}`);
  }
  process.exitCode = kind === "config" ? 2 : 3;
}

function formatHuman(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  return JSON.stringify(value, null, 2);
}

function parseInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new Error(`Expected integer, got ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Expected safe integer, got ${value}`);
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed <= 0) throw new Error(`Expected positive integer, got ${value}`);
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseFilters(values: string[]): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) throw new WenguError("config", `Invalid filter ${value}; expected key=value.`);
    filters[value.slice(0, index)] = value.slice(index + 1);
  }
  return filters;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
