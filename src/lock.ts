import { open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WenguConfig } from "./types.js";
import { WenguError } from "./types.js";

export async function withSyncLock<T>(
  config: WenguConfig,
  options: { breakLock?: boolean },
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(path.dirname(config.storage.data_dir), "lock");
  if (options.breakLock) {
    await rm(lockPath, { force: true });
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
      "utf8",
    );
  } catch (error) {
    const existing = await readFile(lockPath, "utf8").catch(() => "");
    throw new WenguError(
      "transient",
      `Another sync appears to hold ${lockPath}. ${existing}`,
      "If the process is gone, rerun with `--break-lock`.",
    );
  } finally {
    await handle?.close();
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function touchProjectGitignore(projectRoot: string): Promise<void> {
  const gitignore = path.join(projectRoot, ".gitignore");
  const existing = await readFile(gitignore, "utf8").catch(() => "");
  if (!existing.split(/\r?\n/).includes(".wengu/")) {
    await writeFile(gitignore, `${existing}${existing.endsWith("\n") || !existing ? "" : "\n"}.wengu/\n`, "utf8");
  }
}
