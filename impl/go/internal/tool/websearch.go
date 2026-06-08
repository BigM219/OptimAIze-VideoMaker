// websearch — web search with a configurable provider (Go parity of websearch.ts).
// Tavily (default) or Exa, selected by WEBSEARCH_PROVIDER + the matching key in
// env/.env. Without a key it returns an honest "not configured" message instead
// of failing the loop, so the model can proceed on its existing knowledge.
package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	wsDefaultResults = 5
	wsMaxResults     = 10
	wsTimeout        = 25 * time.Second
)

type searchHit struct {
	Title   string
	URL     string
	Content string
}

// resolveProvider picks the active provider + key (Tavily preferred).
func resolveProvider() (provider, key string) {
	explicit := strings.ToLower(readEnv("WEBSEARCH_PROVIDER"))
	tavily := readEnv("TAVILY_API_KEY")
	exa := readEnv("EXA_API_KEY")
	if explicit == "tavily" && tavily != "" {
		return "tavily", tavily
	}
	if explicit == "exa" && exa != "" {
		return "exa", exa
	}
	if tavily != "" {
		return "tavily", tavily
	}
	if exa != "" {
		return "exa", exa
	}
	return "none", ""
}

func searchTavily(ctx context.Context, query string, n int, key string) ([]searchHit, error) {
	payload, _ := json.Marshal(map[string]any{"api_key": key, "query": query, "max_results": n, "search_depth": "basic"})
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.tavily.com/search", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Tavily HTTP %d", resp.StatusCode)
	}
	var data struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	var hits []searchHit
	for _, r := range data.Results {
		hits = append(hits, searchHit{Title: r.Title, URL: r.URL, Content: r.Content})
	}
	return hits, nil
}

func searchExa(ctx context.Context, query string, n int, key string) ([]searchHit, error) {
	payload, _ := json.Marshal(map[string]any{
		"query": query, "numResults": n,
		"contents": map[string]any{"text": map[string]any{"maxCharacters": 1200}},
	})
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.exa.ai/search", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Exa HTTP %d", resp.StatusCode)
	}
	var data struct {
		Results []struct {
			Title string `json:"title"`
			URL   string `json:"url"`
			Text  string `json:"text"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	var hits []searchHit
	for _, r := range data.Results {
		hits = append(hits, searchHit{Title: r.Title, URL: r.URL, Content: r.Text})
	}
	return hits, nil
}

// WebSearchTool searches the web for up-to-date information.
var WebSearchTool = Def{
	ID: "websearch",
	Description: "Search the web for up-to-date information (current events, recent docs, version-specific facts beyond your training). " +
		"Returns titles, URLs, and content snippets. Use webfetch afterward to read a specific result in full.",
	Parameters: []Param{
		{Name: "query", Type: "string", Description: "The search query", Required: true},
		{Name: "numResults", Type: "number", Description: fmt.Sprintf("Number of results (default %d, max %d)", wsDefaultResults, wsMaxResults)},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		query, err := reqString(args, "query")
		if err != nil {
			return nil, err
		}
		n, hasN, err := optNumber(args, "numResults")
		if err != nil {
			return nil, err
		}
		out := map[string]any{"query": query}
		if hasN {
			out["numResults"] = n
		}
		return out, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		query := args["query"].(string)
		provider, key := resolveProvider()
		if provider == "none" {
			return Result{
				Title: query,
				Output: "Web search is not configured. To enable it, set TAVILY_API_KEY (or EXA_API_KEY) in impl/go/.env. " +
					"Proceed using your existing knowledge.",
				Metadata: map[string]any{"error": "not_configured"},
			}, nil
		}
		n := wsDefaultResults
		if v, ok := args["numResults"].(float64); ok && v > 0 {
			n = int(v)
		}
		if n > wsMaxResults {
			n = wsMaxResults
		}
		cctx, cancel := context.WithTimeout(context.Background(), wsTimeout)
		defer cancel()
		var hits []searchHit
		var err error
		if provider == "tavily" {
			hits, err = searchTavily(cctx, query, n, key)
		} else {
			hits, err = searchExa(cctx, query, n, key)
		}
		if err != nil {
			return Result{Title: query, Output: "Web search failed: " + err.Error(), Metadata: map[string]any{"error": "search_failed", "provider": provider}}, nil
		}
		if len(hits) == 0 {
			return Result{Title: query, Output: "No search results found. Try a different query.", Metadata: map[string]any{"provider": provider, "results": 0}}, nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "Web search results (%s) for %q:\n\n", provider, query)
		for i, h := range hits {
			snippet := strings.Join(strings.Fields(h.Content), " ")
			if len(snippet) > 500 {
				snippet = snippet[:500]
			}
			fmt.Fprintf(&b, "%d. %s\n   %s\n   %s\n\n", i+1, h.Title, h.URL, snippet)
		}
		out, truncated, outputPath := truncateOutput(ctx, "websearch", strings.TrimRight(b.String(), "\n"), outputCap)
		return Result{Title: query, Output: out, Truncated: truncated, OutputPath: outputPath, Metadata: map[string]any{"provider": provider, "results": len(hits)}}, nil
	},
}
