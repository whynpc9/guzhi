import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import type { WenguConfig } from "./types.js";
import { WenguError } from "./types.js";
import { posixPath } from "./util.js";

export interface DiscoveredFile {
  path: string;
  absolutePath: string;
}

export async function discoverMarkdownFiles(config: WenguConfig): Promise<DiscoveredFile[]> {
  const hardExcludes = [".git/**", ".wengu/**", "node_modules/**"];
  const exclude = [...hardExcludes, ...config.discovery.exclude];
  try {
    const entries = await fg(config.discovery.include, {
      cwd: config.repo.root,
      absolute: false,
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: config.discovery.follow_symlinks,
      ignore: exclude,
      unique: true,
    });
    const gitignore = config.discovery.respect_gitignore
      ? await loadGitignore(config.repo.root)
      : null;
    return entries
      .map(posixPath)
      .filter((entry) => !gitignore?.ignores(entry))
      .sort((a, b) => a.localeCompare(b))
      .map((entry) => ({
        path: entry,
        absolutePath: path.resolve(config.repo.root, entry),
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WenguError(
      "transient",
      `Discovery failed: ${message}`,
      "Fix the filesystem error and rerun `wengu sync`.",
    );
  }
}

async function loadGitignore(root: string): Promise<ReturnType<typeof ignore> | null> {
  try {
    const raw = await readFile(path.join(root, ".gitignore"), "utf8");
    return ignore().add(raw);
  } catch {
    return null;
  }
}
