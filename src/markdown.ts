import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Diagnostic,
  ExtractedLink,
  JsonRecord,
  ParsedChunk,
  ParsedDocument,
  ParsedFrontmatter,
  WenguConfig,
} from "./types.js";
import {
  commonPrefixScore,
  conceptIdFromPath,
  headingAnchor,
  humanizeSlug,
  jsonObject,
  sha256,
  slugFromPath,
  stableJson,
  toBoolean,
  toIsoString,
  unique,
} from "./util.js";
import { estimateTokens } from "./tokenize.js";

const CORE_FRONTMATTER_KEYS = new Set([
  "title",
  "type",
  "description",
  "tags",
  "timestamp",
  "updated",
  "created",
  "resource",
]);

export async function parseMarkdownDocument(
  filePath: string,
  absolutePath: string,
  config: WenguConfig,
): Promise<ParsedDocument> {
  const fileStat = await stat(absolutePath);
  const bytes = await readFile(absolutePath);
  const diagnostics: Diagnostic[] = [];
  const slug = slugFromPath(filePath);
  const conceptId = conceptIdFromPath(filePath);
  const reserved = path.posix.basename(filePath) === "index.md" || path.posix.basename(filePath) === "log.md";

  if (bytes.includes(0)) {
    diagnostics.push({
      kind: "binary_markdown_skipped",
      message: "File contains NUL bytes and was skipped.",
      path: filePath,
    });
    return emptyDocument(filePath, absolutePath, fileStat.size, fileStat.mtimeMs, slug, conceptId, diagnostics);
  }

  let content = bytes.toString("utf8");
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content = content.replace(/\r\n?/g, "\n");
  const contentHash = sha256(content);
  const { frontmatter, body } = parseFrontmatter(content, filePath, config);
  diagnostics.push(...frontmatter.diagnostics);

  const cleanBody = stripHtmlComments(body);
  const firstH1 = findFirstHeading(cleanBody, 1);
  const title =
    frontmatter.normalized.title?.trim() ||
    firstH1?.trim() ||
    humanizeSlug(slug);
  const description = frontmatter.normalized.description ?? null;
  const type = frontmatter.normalized.type ?? null;
  const tags = frontmatter.normalized.tags;
  const links = extractLinks(cleanBody, filePath);
  const chunks = buildChunks({
    title,
    description,
    tags,
    body: cleanBody,
    config,
  });

  return {
    path: filePath,
    absolutePath,
    slug,
    conceptId,
    title,
    type,
    description,
    tags,
    createdTs: frontmatter.normalized.created_ts ?? null,
    updatedTs: frontmatter.normalized.updated_ts ?? null,
    facets: frontmatter.normalized.facets,
    frontmatterRaw: frontmatter.raw,
    contentHash,
    frontmatterHash: frontmatter.hash,
    sizeBytes: fileStat.size,
    fileMtime: fileStat.mtimeMs,
    tier: commonPrefixScore(filePath, config.search.tier_boost),
    reserved,
    diagnostics,
    chunks,
    links,
    excluded: frontmatter.excluded,
  };
}

function parseFrontmatter(content: string, filePath: string, config: WenguConfig): {
  frontmatter: ParsedFrontmatter;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return {
      frontmatter: {
        raw: {},
        normalized: { tags: [], facets: {} },
        hash: sha256(""),
        diagnostics: [],
        excluded: false,
      },
      body: content,
    };
  }

  const closingMatch = /\n---[ \t]*\n/.exec(content.slice(4));
  if (!closingMatch) {
    return {
      frontmatter: {
        raw: {},
        normalized: { tags: [], facets: {} },
        hash: sha256(""),
        diagnostics: [
          {
            kind: "frontmatter_parse_error",
            message: "Opening frontmatter delimiter has no closing delimiter.",
            path: filePath,
          },
        ],
        excluded: false,
      },
      body: content,
    };
  }

  const frontmatterText = content.slice(4, 4 + closingMatch.index);
  const body = content.slice(4 + closingMatch.index + closingMatch[0].length);
  const diagnostics: Diagnostic[] = [];
  let raw: JsonRecord = {};
  try {
    raw = jsonObject(parseYaml(frontmatterText) ?? {});
  } catch (error) {
    diagnostics.push({
      kind: "frontmatter_parse_error",
      message: error instanceof Error ? error.message : String(error),
      path: filePath,
    });
    return {
      frontmatter: {
        raw: {},
        normalized: { tags: [], facets: {} },
        hash: sha256(frontmatterText),
        diagnostics,
        excluded: false,
      },
      body: content,
    };
  }

  const excluded = config.discovery.exclude_frontmatter_flags.some((flag) => toBoolean(raw[flag]) === true);
  return {
    frontmatter: {
      raw,
      normalized: normalizeFrontmatter(raw, diagnostics, filePath),
      hash: sha256(stableJson(raw)),
      diagnostics,
      excluded,
    },
    body,
  };
}

function normalizeFrontmatter(
  raw: JsonRecord,
  diagnostics: Diagnostic[],
  filePath: string,
): ParsedFrontmatter["normalized"] {
  const tagsValue = raw.tags;
  const tags = unique(
    (Array.isArray(tagsValue) ? tagsValue : tagsValue == null ? [] : [tagsValue])
      .map((item) => String(item).trim())
      .filter(Boolean),
  );

  const facets: JsonRecord = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!CORE_FRONTMATTER_KEYS.has(key)) {
      facets[key] = normalizeScalar(value);
    }
  }

  const created = toIsoString(raw.created ?? raw.timestamp);
  const updated = toIsoString(raw.updated ?? raw.timestamp);
  if ((raw.created || raw.timestamp) && !created) {
    diagnostics.push({
      kind: "frontmatter_normalization_warning",
      message: "Could not normalize created/timestamp field.",
      path: filePath,
    });
  }

  return {
    title: typeof raw.title === "string" ? raw.title : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    description: typeof raw.description === "string" ? raw.description : undefined,
    tags,
    created_ts: created,
    updated_ts: updated,
    facets,
  };
}

function normalizeScalar(value: unknown): unknown {
  if (typeof value === "string") {
    const bool = toBoolean(value);
    if (bool !== undefined) return bool;
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeScalar);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, child]) => [key, normalizeScalar(child)]));
  }
  return value;
}

function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}

function findFirstHeading(body: string, level: number): string | null {
  const prefix = "#".repeat(level);
  for (const line of body.split("\n")) {
    const match = new RegExp(`^${prefix}\\s+(.+?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return null;
}

function extractLinks(body: string, filePath: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const lines = body.split("\n");
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    collectWikiLinks(line, links);
    collectMarkdownLinks(line, filePath, links);
    collectFootnoteSources(line, filePath, links);
  }
  return links;
}

function collectWikiLinks(line: string, links: ExtractedLink[]): void {
  const wikiRegex = /\[\[([^\]]+)]]/g;
  for (const match of line.matchAll(wikiRegex)) {
    const parsed = parseWikiTarget(match[1]);
    links.push({
      kind: "wikilink",
      rawTarget: match[1],
      normalizedTarget: parsed.target,
      anchor: parsed.anchor,
      alias: parsed.alias,
    });
  }
}

function parseWikiTarget(raw: string): { target: string; anchor: string | null; alias: string | null } {
  const [targetAndAnchor, alias] = raw.split("|", 2);
  const [target, anchor] = targetAndAnchor.split("#", 2);
  return {
    target: target.trim(),
    anchor: anchor?.trim() || null,
    alias: alias?.trim() || null,
  };
}

function collectMarkdownLinks(line: string, filePath: string, links: ExtractedLink[]): void {
  const mdRegex = /(?<!!)\[([^\]]+)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of line.matchAll(mdRegex)) {
    const label = match[1];
    const rawTarget = match[2];
    if (/^https?:\/\//i.test(rawTarget)) {
      links.push({
        kind: "external",
        rawTarget,
        normalizedTarget: rawTarget,
        anchor: null,
        alias: label,
      });
      continue;
    }
    const [targetWithoutAnchor, anchor] = rawTarget.split("#", 2);
    if (!targetWithoutAnchor.endsWith(".md")) continue;
    const kind = targetWithoutAnchor.startsWith("/") ? "mdlink_absolute" : "mdlink_relative";
    links.push({
      kind,
      rawTarget,
      normalizedTarget: normalizeMarkdownTarget(targetWithoutAnchor, filePath),
      anchor: anchor || null,
      alias: label,
    });
  }
}

function collectFootnoteSources(line: string, filePath: string, links: ExtractedLink[]): void {
  const footnoteRegex = /\^\[([^\]\n]+?\.md(?:#[^\]\n]+)?)\]/g;
  for (const match of line.matchAll(footnoteRegex)) {
    const rawTarget = match[1].trim();
    const [targetWithoutAnchor, anchor] = rawTarget.split("#", 2);
    links.push({
      kind: "footnote_source",
      rawTarget,
      normalizedTarget: normalizeFootnoteTarget(targetWithoutAnchor, filePath),
      anchor: anchor || null,
      alias: null,
    });
  }
}

function normalizeFootnoteTarget(target: string, filePath: string): string {
  const decoded = decodeURIComponent(target);
  if (decoded.startsWith("/") || /^[A-Za-z0-9_-]+\//.test(decoded)) {
    return decoded.replace(/^\//, "");
  }
  return normalizeMarkdownTarget(decoded, filePath);
}

function normalizeMarkdownTarget(target: string, filePath: string): string {
  const decoded = decodeURIComponent(target);
  if (decoded.startsWith("/")) {
    return decoded.slice(1).replace(/^\.\//, "");
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(filePath), decoded));
}

function buildChunks(input: {
  title: string;
  description: string | null;
  tags: string[];
  body: string;
  config: WenguConfig;
}): ParsedChunk[] {
  const summary = [input.title, input.description, input.tags.join(" ")].filter(Boolean).join("\n");
  const chunks: ParsedChunk[] = [
    makeChunk(0, ["Document Summary"], "summary", summary || input.title, input.config, ["summary"]),
  ];

  const sections = splitSections(input.body);
  let seq = 1;
  for (const section of sections) {
    for (const body of splitOversizeSection(section.body, input.config)) {
      chunks.push(makeChunk(seq, section.headingPath, section.anchor, body, input.config, []));
      seq += 1;
    }
  }
  return chunks.filter((chunk) => chunk.body.trim().length > 0);
}

interface Section {
  headingPath: string[];
  anchor: string | null;
  body: string;
}

function splitSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: string[] = [];
  let headingStack: string[] = [];
  let currentAnchor: string | null = null;
  let inFence = false;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) {
      sections.push({
        headingPath: headingStack.length ? [...headingStack] : ["Document"],
        anchor: currentAnchor,
        body: text,
      });
    }
    current = [];
  };

  for (const line of body.split("\n")) {
    if (/^\s*```/.test(line) || /^\s*~~~/.test(line)) {
      inFence = !inFence;
    }
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2].trim();
      headingStack = [...headingStack.slice(0, level - 1), text];
      currentAnchor = headingAnchor(text);
      current.push(line);
    } else {
      current.push(line);
    }
  }
  flush();
  return sections;
}

function splitOversizeSection(sectionBody: string, config: WenguConfig): string[] {
  if (estimateTokens(sectionBody, config.chunking.cjk_char_per_token) <= config.chunking.max_tokens) {
    return [sectionBody];
  }
  const blocks = sectionBody.split(/\n{2,}/);
  const output: string[] = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (
      current &&
      estimateTokens(candidate, config.chunking.cjk_char_per_token) > config.chunking.target_tokens
    ) {
      output.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) output.push(current);
  return output.length ? output : [sectionBody];
}

function makeChunk(
  seq: number,
  headingPath: string[],
  anchor: string | null,
  body: string,
  config: WenguConfig,
  flags: string[],
): ParsedChunk {
  const tokenEstimate = estimateTokens(body, config.chunking.cjk_char_per_token);
  return {
    seq,
    headingPath,
    anchor,
    body,
    tokenEstimate,
    contentHash: sha256(body),
    flags: tokenEstimate > config.chunking.max_tokens ? unique([...flags, "oversize"]) : flags,
  };
}

function emptyDocument(
  filePath: string,
  absolutePath: string,
  sizeBytes: number,
  fileMtime: number,
  slug: string,
  conceptId: string,
  diagnostics: Diagnostic[],
): ParsedDocument {
  return {
    path: filePath,
    absolutePath,
    slug,
    conceptId,
    title: humanizeSlug(slug),
    type: null,
    description: null,
    tags: [],
    createdTs: null,
    updatedTs: null,
    facets: {},
    frontmatterRaw: {},
    contentHash: sha256(""),
    frontmatterHash: sha256(""),
    sizeBytes,
    fileMtime,
    tier: 1,
    reserved: false,
    diagnostics,
    chunks: [],
    links: [],
    excluded: true,
  };
}
