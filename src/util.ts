import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function posixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

export function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

export function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (ch) => ch.toUpperCase());
}

export function slugFromPath(repoRelativePath: string): string {
  return path.posix.basename(repoRelativePath, path.posix.extname(repoRelativePath));
}

export function conceptIdFromPath(repoRelativePath: string): string {
  return repoRelativePath.replace(/\.md$/i, "");
}

export function headingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function newId(): string {
  return randomUUID();
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

export function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
    return trimmed;
  }
  return undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

export function commonPrefixScore(relativePath: string, boosts: Record<string, number>): number {
  let matched: { prefix: string; boost: number } | null = null;
  for (const [prefix, boost] of Object.entries(boosts)) {
    if (relativePath.startsWith(prefix)) {
      if (!matched || prefix.length > matched.prefix.length) {
        matched = { prefix, boost };
      }
    }
  }
  return matched?.boost ?? 1;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return value as number[];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parseVector(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
