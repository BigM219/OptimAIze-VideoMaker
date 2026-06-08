// OpenRouter chat-completions client (stdlib net/http). Mirrors llm_client.py:
// env/.env config, 429/5xx backoff, choices validation.
package agent

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var retryCodes = map[int]bool{429: true, 500: true, 502: true, 503: true, 529: true}

type LLMClient struct {
	apiKey  string
	baseURL string
	// z.ai is a separate OpenAI-compatible provider; a model entry prefixed
	// "zai:" routes there (own base URL + key) instead of OpenRouter.
	zaiKey     string
	zaiBaseURL string
	// dotenv holds parsed .env values for resolving custom-provider key env vars.
	dotenv map[string]string
	// Models is an ordered fallback list. The client tries each in turn until
	// one returns a usable completion; only if all fail does Chat error out.
	Models []string
}

// resolve picks the provider for a model entry. "zai:glm-4.6" -> z.ai;
// "custom:<KEY_ENV>|<BASE_URL>|<MODEL_ID>" -> any OpenAI-compatible host.
func (c *LLMClient) resolve(model string) (url, key, name string, openrouter bool) {
	if strings.HasPrefix(model, "zai:") {
		return c.zaiBaseURL, c.zaiKey, strings.TrimPrefix(model, "zai:"), false
	}
	if strings.HasPrefix(model, "custom:") {
		parts := strings.SplitN(strings.TrimPrefix(model, "custom:"), "|", 3)
		if len(parts) == 3 {
			k := os.Getenv(parts[0])
			if k == "" {
				k = c.dotenv[parts[0]]
			}
			return strings.TrimRight(parts[1], "/"), k, parts[2], false
		}
	}
	return c.baseURL, c.apiKey, model, true
}

// Model reports the primary (first) model, for status/logging.
func (c *LLMClient) Model() string {
	if len(c.Models) > 0 {
		return c.Models[0]
	}
	return ""
}

func loadDotenv() map[string]string {
	out := map[string]string{}
	// impl/go/internal/agent -> impl/go/.env
	exe, _ := os.Executable()
	candidates := []string{
		filepath.Join(filepath.Dir(exe), ".env"),
		".env",
	}
	for _, p := range candidates {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if eq := strings.IndexByte(line, '='); eq != -1 {
				out[strings.TrimSpace(line[:eq])] = strings.TrimSpace(line[eq+1:])
			}
		}
		f.Close()
		break
	}
	return out
}

func NewLLMClient() *LLMClient {
	dot := loadDotenv()
	pick := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		if v, ok := dot[name]; ok && v != "" {
			return v
		}
		return fallback
	}
	// The model chain comes from the runtime-editable models.json (GetModels),
	// which bootstraps from OPENROUTER_MODEL on first run.
	models := enabledChain()
	return &LLMClient{
		apiKey:     pick("OPENROUTER_API_KEY", ""),
		baseURL:    strings.TrimRight(pick("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), "/"),
		zaiKey:     pick("ZAI_API_KEY", ""),
		zaiBaseURL: strings.TrimRight(pick("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4"), "/"),
		dotenv:     dot,
		Models:     models,
	}
}

func (c *LLMClient) IsConfigured() bool {
	return c.apiKey != "" && c.apiKey != "REPLACE_WITH_YOUR_OPENROUTER_KEY"
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c *LLMClient) Chat(messages []ChatMessage, maxTokens int, temperature float64) (string, error) {
	if !c.IsConfigured() {
		return "", errors.New("no OPENROUTER_API_KEY configured (set it in impl/go/.env)")
	}
	if len(c.Models) == 0 {
		return "", errors.New("no OPENROUTER_MODEL configured")
	}
	var lastErr string
	triedAny := false
	// Try each model in the configured fallback order, skipping tripped ones.
	for _, model := range c.Models {
		if isTripped(model) {
			fmt.Printf("LLM model %s skipped (tripped after %d failures this session).\n", model, maxModelFailures)
			continue
		}
		triedAny = true
		out, err := c.chatModel(model, messages, maxTokens, temperature)
		if err == nil {
			recordSuccess(model)
			return out, nil
		}
		recordFailure(model)
		lastErr = fmt.Sprintf("[%s] %s", model, err.Error())
		fmt.Printf("LLM model %s failed, falling back: %s\n", model, err.Error())
	}
	if !triedAny {
		resetBreaker()
		return "", fmt.Errorf("all models tripped this session; breaker reset. last: %s", lastErr)
	}
	return "", fmt.Errorf("all %d models failed; last: %s", len(c.Models), lastErr)
}

// Circuit breaker with a time-based cooldown: a model that fails
// maxModelFailures times is skipped, but only until cooldownSeconds elapse, so a
// transient all-provider outage doesn't permanently disable every model for the
// rest of the session. A success clears the model's state immediately.
const (
	maxModelFailures = 2
	cooldownSeconds  = 90
)

var (
	breakerMu     sync.Mutex
	modelFailures = map[string]int{}
	trippedUntil  = map[string]time.Time{}
)

func isTripped(model string) bool {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	until, ok := trippedUntil[model]
	if !ok {
		return false
	}
	if time.Now().After(until) {
		// Cooldown elapsed: give the model another chance.
		delete(trippedUntil, model)
		modelFailures[model] = 0
		return false
	}
	return true
}
func recordFailure(model string) {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	modelFailures[model]++
	if modelFailures[model] >= maxModelFailures {
		trippedUntil[model] = time.Now().Add(cooldownSeconds * time.Second)
	}
}
func recordSuccess(model string) {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	delete(modelFailures, model)
	delete(trippedUntil, model)
}
func resetBreaker() {
	breakerMu.Lock()
	defer breakerMu.Unlock()
	modelFailures = map[string]int{}
	trippedUntil = map[string]time.Time{}
}

// chatModel runs the retry loop for a single model.
func (c *LLMClient) chatModel(model string, messages []ChatMessage, maxTokens int, temperature float64) (string, error) {
	url, key, name, openrouter := c.resolve(model)
	if key == "" {
		if openrouter {
			return "", errors.New("no OPENROUTER_API_KEY configured")
		}
		return "", errors.New("no ZAI_API_KEY configured")
	}
	body, _ := json.Marshal(map[string]any{
		"model": name, "messages": messages, "max_tokens": maxTokens, "temperature": temperature,
	})
	client := &http.Client{Timeout: 60 * time.Second}
	// One attempt per model: the fallback list is the redundancy, and the
	// session breaker skips reliably-failing models entirely.
	maxRetries := 1
	var lastErr string
	for attempt := 0; attempt < maxRetries; attempt++ {
		req, _ := http.NewRequest("POST", url+"/chat/completions", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		if openrouter {
			req.Header.Set("HTTP-Referer", "https://optimaize.local/videomaker")
			req.Header.Set("X-Title", "OptimAIze-VideoMaker")
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err.Error()
			time.Sleep(backoff(attempt))
			continue
		}
		data, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			lastErr = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, trim(string(data), 200))
			if retryCodes[resp.StatusCode] {
				time.Sleep(backoff(attempt))
				continue
			}
			return "", errors.New(lastErr)
		}
		var parsed struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal(data, &parsed) != nil || len(parsed.Choices) == 0 {
			return "", fmt.Errorf("invalid response body: %s", trim(string(data), 300))
		}
		content := parsed.Choices[0].Message.Content
		if strings.TrimSpace(content) == "" {
			return "", errors.New("empty completion content")
		}
		return content, nil
	}
	return "", fmt.Errorf("unreachable after %d attempts: %s", maxRetries, lastErr)
}

func backoff(attempt int) time.Duration {
	s := 1 << attempt * 2
	if s > 20 {
		s = 20
	}
	return time.Duration(s) * time.Second
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
