// Runtime-editable model fallback config. Users can add models from multiple
// providers (OpenRouter, z.ai, or any OpenAI-compatible base URL) and set the
// priority order. Persisted to models.json next to .env so it survives restart;
// falls back to the OPENROUTER_MODEL env list on first run.
package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ModelEntry is one model in the ordered fallback chain.
type ModelEntry struct {
	Model    string `json:"model"`
	Provider string `json:"provider"` // "openrouter" (default), "zai", or "custom"
	BaseURL  string `json:"baseUrl,omitempty"`
	KeyEnv   string `json:"keyEnv,omitempty"`
	Enabled  bool   `json:"enabled"`
}

var (
	cfgMu    sync.Mutex
	cfgCache []ModelEntry
)

func modelsConfigPath() string {
	exe, _ := os.Executable()
	// binary lives in impl/go/ -> models.json beside it; fall back to cwd.
	if exe != "" {
		return filepath.Join(filepath.Dir(exe), "models.json")
	}
	return "models.json"
}

// entryFromToken turns a chain token like "zai:glm-5.1" into a structured entry.
func entryFromToken(token string) ModelEntry {
	if strings.HasPrefix(token, "zai:") {
		return ModelEntry{Model: token[4:], Provider: "zai", Enabled: true}
	}
	return ModelEntry{Model: token, Provider: "openrouter", Enabled: true}
}

// tokenFromEntry turns an entry back into a chain token the client understands.
func tokenFromEntry(e ModelEntry) string {
	switch e.Provider {
	case "zai":
		return "zai:" + e.Model
	case "custom":
		return "custom:" + e.KeyEnv + "|" + e.BaseURL + "|" + e.Model
	default:
		return e.Model
	}
}

func defaultEntries() []ModelEntry {
	raw := loadDotenv()["OPENROUTER_MODEL"]
	if v := os.Getenv("OPENROUTER_MODEL"); v != "" {
		raw = v
	}
	if raw == "" {
		raw = "openrouter/owl-alpha"
	}
	var out []ModelEntry
	for _, m := range strings.Split(raw, ",") {
		if m = strings.TrimSpace(m); m != "" {
			out = append(out, entryFromToken(m))
		}
	}
	return out
}

// GetModels returns the configured model entries (cached, bootstrapped from env).
func GetModels() []ModelEntry {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	if cfgCache != nil {
		return cfgCache
	}
	if data, err := os.ReadFile(modelsConfigPath()); err == nil {
		var entries []ModelEntry
		if json.Unmarshal(data, &entries) == nil && len(entries) > 0 {
			cfgCache = entries
			return cfgCache
		}
	}
	cfgCache = defaultEntries()
	return cfgCache
}

// SetModels persists a new model list and updates the cache.
func SetModels(entries []ModelEntry) []ModelEntry {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	var clean []ModelEntry
	for _, e := range entries {
		if strings.TrimSpace(e.Model) != "" {
			if e.Provider == "" {
				e.Provider = "openrouter"
			}
			clean = append(clean, e)
		}
	}
	cfgCache = clean
	if data, err := json.MarshalIndent(clean, "", "  "); err == nil {
		_ = os.WriteFile(modelsConfigPath(), data, 0o644)
	}
	return clean
}

// enabledChain is the ordered list of enabled chain tokens, for the client.
func enabledChain() []string {
	var out []string
	for _, e := range GetModels() {
		if e.Enabled {
			out = append(out, tokenFromEntry(e))
		}
	}
	return out
}
