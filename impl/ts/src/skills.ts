// Loads the bundled video best-practices skill (.optimaize/skills/video-skills)
// and exposes it to the LLM. SKILL.md is the always-on core; rules/*.md are
// loaded on demand by keyword so we feed the model domain knowledge without
// blowing the context budget. The .optimaize layout mirrors the .claude skills
// convention but keeps the module project-independent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// dist/skills.js or src/skills.ts -> module root /.optimaize/skills/video-skills
function skillRoot(): string {
  const candidates = [
    path.resolve(here, "..", "..", "..", ".optimaize", "skills", "video-skills"),
    path.resolve(here, "..", "..", ".optimaize", "skills", "video-skills"),
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

// Metadata for the settings/config UI: skill name, description, the core size,
// and the list of on-demand rules. Lets the user see what the LLM is given.
export function skillInfo(): {
  available: boolean;
  name: string;
  description: string;
  path: string;
  core_chars: number;
  rules: string[];
} {
  const root = skillRoot();
  if (!fs.existsSync(path.join(root, "SKILL.md"))) {
    return { available: false, name: "", description: "", path: root, core_chars: 0, rules: [] };
  }
  const raw = fs.readFileSync(path.join(root, "SKILL.md"), "utf-8");
  const nameMatch = raw.match(/name:\s*(.+)/);
  const descMatch = raw.match(/description:\s*(.+)/);
  let rules: string[] = [];
  try {
    rules = fs.readdirSync(path.join(root, "rules")).filter((f) => f.endsWith(".md")).sort();
  } catch {
    /* none */
  }
  return {
    available: true,
    name: nameMatch?.[1]?.trim() ?? "video-skills",
    description: descMatch?.[1]?.trim() ?? "",
    path: root,
    core_chars: skillCore().length,
    rules,
  };
}

// Read one rule's content (for the UI to display on click). Guards traversal.
export function skillRule(name: string): string | null {
  if (!/^[\w.-]+\.md$/.test(name)) return null;
  try {
    return fs.readFileSync(path.join(skillRoot(), "rules", name), "utf-8");
  } catch {
    return null;
  }
}
