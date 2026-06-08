// Loads the bundled video best-practices skill (.optimaize/skills/video-skills)
// and exposes it to the LLM. SKILL.md is the always-on core; rules/*.md are
// loaded on demand by keyword. Mirrors the TS skills loader.
package skills

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

func skillRoot() string {
	// exe-dir or cwd -> module root /.optimaize/skills/video-skills
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, ".optimaize", "skills", "video-skills"),
			filepath.Join(dir, "..", "..", ".optimaize", "skills", "video-skills"),
		)
	}
	candidates = append(candidates,
		filepath.Join(".optimaize", "skills", "video-skills"),
		filepath.Join("..", "..", ".optimaize", "skills", "video-skills"),
	)
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, "SKILL.md")); err == nil {
			return c
		}
	}
	return candidates[len(candidates)-1]
}

var frontmatter = regexp.MustCompile(`(?s)^---.*?---\s*`)

// Core returns the always-on SKILL.md content, frontmatter stripped.
func Core() string {
	b, err := os.ReadFile(filepath.Join(skillRoot(), "SKILL.md"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(frontmatter.ReplaceAllString(string(b), ""))
}

// RulesFor returns the concatenated content of rules whose filename keywords
// match the given text, capped at maxChars.
func RulesFor(text string, maxChars int) string {
	dir := filepath.Join(skillRoot(), "rules")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	lc := strings.ToLower(text)
	type scored struct {
		file string
		hits int
	}
	var ranked []scored
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		topic := strings.ReplaceAll(strings.TrimSuffix(e.Name(), ".md"), "-", " ")
		hits := 0
		for _, w := range strings.Fields(topic) {
			if len(w) > 2 && strings.Contains(lc, w) {
				hits++
			}
		}
		if hits > 0 {
			ranked = append(ranked, scored{e.Name(), hits})
		}
	}
	sort.Slice(ranked, func(i, j int) bool { return ranked[i].hits > ranked[j].hits })

	var out strings.Builder
	for i, r := range ranked {
		if i >= 3 {
			break
		}
		b, err := os.ReadFile(filepath.Join(dir, r.file))
		if err != nil {
			continue
		}
		block := "\n\n## Rule: " + r.file + "\n" + strings.TrimSpace(string(b))
		if out.Len()+len(block) > maxChars {
			break
		}
		out.WriteString(block)
	}
	return out.String()
}

// Info returns metadata for the settings UI.
func Info() map[string]any {
	root := skillRoot()
	raw, err := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if err != nil {
		return map[string]any{"available": false, "name": "", "description": "", "path": root, "core_chars": 0, "rules": []string{}}
	}
	name, desc := "video-skills", ""
	if m := regexp.MustCompile(`name:\s*(.+)`).FindStringSubmatch(string(raw)); m != nil {
		name = strings.TrimSpace(m[1])
	}
	if m := regexp.MustCompile(`description:\s*(.+)`).FindStringSubmatch(string(raw)); m != nil {
		desc = strings.TrimSpace(m[1])
	}
	var rules []string
	if entries, err := os.ReadDir(filepath.Join(root, "rules")); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
				rules = append(rules, e.Name())
			}
		}
		sort.Strings(rules)
	}
	return map[string]any{
		"available":   true,
		"name":        name,
		"description": desc,
		"path":        root,
		"core_chars":  len(Core()),
		"rules":       rules,
	}
}

// Rule returns one rule's content, guarding path traversal.
func Rule(name string) (string, bool) {
	if !regexp.MustCompile(`^[\w.-]+\.md$`).MatchString(name) {
		return "", false
	}
	b, err := os.ReadFile(filepath.Join(skillRoot(), "rules", name))
	if err != nil {
		return "", false
	}
	return string(b), true
}
