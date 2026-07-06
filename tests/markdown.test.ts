import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseMarkdownDocument } from "../src/markdown.js";

describe("parseMarkdownDocument", () => {
  it("parses tolerant frontmatter, links, and repo-root footnote sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-md-"));
    try {
      const file = path.join(root, "concepts", "sample.md");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        [
          "---",
          "title: Sample Page",
          "type: concept",
          "tags: clinical",
          "safe_for_daily_qa: true",
          "---",
          "# Heading",
          "",
          "[[target-page|Target]]",
          "^[raw/clinical/source.md]",
          "",
          "```",
          "[[not-a-link]]",
          "```",
        ].join("\n"),
        "utf8",
      );
      const loaded = await loadConfig({ cwd: root, repoRoot: root });
      const parsed = await parseMarkdownDocument("concepts/sample.md", file, loaded.config);

      expect(parsed.title).toBe("Sample Page");
      expect(parsed.tags).toEqual(["clinical"]);
      expect(parsed.facets.safe_for_daily_qa).toBe(true);
      expect(parsed.links.map((link) => [link.kind, link.normalizedTarget])).toEqual([
        ["wikilink", "target-page"],
        ["footnote_source", "raw/clinical/source.md"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors excluded_from_wiki_knowledge_base", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guzhi-md-"));
    try {
      const file = path.join(root, "eval.md");
      await writeFile(
        file,
        ["---", "title: Eval", "excluded_from_wiki_knowledge_base: true", "---", "hidden"].join("\n"),
        "utf8",
      );
      const loaded = await loadConfig({ cwd: root, repoRoot: root });
      const parsed = await parseMarkdownDocument("eval.md", file, loaded.config);
      expect(parsed.excluded).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
