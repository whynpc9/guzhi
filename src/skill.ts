import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GuzhiConfig } from "./types.js";

export async function installSkill(config: GuzhiConfig): Promise<string> {
  const skillDir = path.join(config.repo.root, "skills", "guzhi-retrieval");
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  const facets = ["coding_system", "confidence", "evidence_level", "safe_for_daily_qa", "question_types", "specialty"];
  const content = `# Guzhi Retrieval

Use this skill when you need to locate source pages in this wiki before answering.

## Commands

- Search first: \`guzhi search "<query>" --json\`
- Resolve a slug: \`guzhi resolve <slug> --json\`
- Inspect links and backlinks: \`guzhi links <path-or-slug> --json\`

## Discipline

- Search results are locators, not final evidence. Read the returned Markdown files before citing or making row-level claims.
- Check \`retrieval_mode\`. If it is \`keyword_only\`, recall may be degraded.
- Treat \`raw/\` and \`_meta/\` hits as routing or provenance material unless the repo's own evidence policy says otherwise.
- Use facet filters when the question supplies context, for example \`--filter coding_system=clinical\`.

## Repo Settings

Tier boosts:

\`\`\`json
${JSON.stringify(config.search.tier_boost, null, 2)}
\`\`\`

Common facets to try:

${facets.map((facet) => `- \`${facet}\``).join("\n")}
`;
  await writeFile(skillPath, content, "utf8");
  return skillPath;
}
