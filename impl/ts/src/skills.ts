// Loads the bundled video best-practices skill (.claude/skills/video-skills) and
// exposes it to the LLM. SKILL.md is the always-on core; rules/*.md are loaded
// on demand by keyword so we feed the model domain knowledge without blowing the
// context budget. Mirrors the .claude skills layout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// dist/skills.js or src/skills.ts -> module root /.claude/skills/video-skills
function skillRoot(): string {
  const candidates = [
    path.resolve(here, "..", "..", "..", ".claude", "skills", "video-skills"),
    path.resolve(here, "..", "..", ".claude", "skills", "video-skills"),
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, "SKILL.md"))) ?? candidates[0];
}

let coreCache: string | null = null;

// The always-on core skill (SKILL.md), trimmed of frontmatter.
export function skillCore(): string {
  if (coreCache !== null) return coreCache;
  try {
    let text = fs.readFileSync(path.join(skillRoot(), "SKILL.md"), "utf-8");
    text = text.replace(/^---[\s\S]*?---\s*/, "");
    coreCache = text.trim();
  } catch {
    coreCache = "";
  }
  return coreCache;
}

// Pick rules whose filename matches keywords in the text and return their
// concatenated content (capped), enriching a scene prompt with the right rule.
export function skillRulesFor(text: string, maxChars = 6000): string {
  const dir = path.join(skillRoot(), "rules");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  const lc = text.toLowerCase();
  const scored: Array<{ file: string; hits: number }> = [];
  for (const f of files) {
    const topic = f.replace(/\.md$/, "").replace(/-/g, " ");
    const words = topic.split(" ").filter((w) => w.length > 2);
    const hits = words.reduce((n, w) => (lc.includes(w) ? n + 1 : n), 0);
    if (hits > 0) scored.push({ file: f, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);

  let out = "";
  for (const { file } of scored.slice(0, 3)) {
    try {
      const body = fs.readFileSync(path.join(dir, file), "utf-8").trim();
      const block = `\n\n## Rule: ${file}\n${body}`;
      if (out.length + block.length > maxChars) break;
      out += block;
    } catch {
      /* skip */
    }
  }
  return out;
}

export function skillAvailable(): boolean {
  return fs.existsSync(path.join(skillRoot(), "SKILL.md"));
}
