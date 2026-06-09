// websearch — web search with a configurable provider (Go parity of websearch.ts).
// Provider order: an API key (Tavily/Exa) if configured, else a keyless scrape of
// DuckDuckGo's HTML endpoint. The scrape path means search works out of the box
// without a key, at the cost of lower reliability (rate-limits, layout drift) — so
// it fails soft rather than crashing the loop. Set WEBSEARCH_PROVIDER=none to disable.
package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	wsDefaultResults = 5
	wsMaxResults     = 10
	wsTimeout        = 25 * time.Second
	wsUA             = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

type searchHit struct {
	Title   string
	URL     string
	Content string
}

// resolveProvider picks the active provider + key. An explicit WEBSEARCH_PROVIDER
// wins; otherwise prefer a configured API key (Tavily first), else the keyless
// DuckDuckGo scrape so search works without any configuration. "none" disables it.
func resolveProvider() (provider, key string) {
	explicit := strings.ToLower(readEnv("WEBSEARCH_PROVIDER"))
	tavily := readEnv("TAVILY_API_KEY")
	exa := readEnv("EXA_API_KEY")
	if explicit == "none" {
		return "none", ""
	}
	if explicit == "scrape" {
		return "scrape", ""
	}
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
	return "scrape", ""
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

// searchScrape queries DuckDuckGo's HTML endpoint (keyless). It returns static
// HTML with far less bot-blocking than Google/Bing; still rate-limited and the
// layout can drift, so the parser is defensive and failures are treated as soft.
func searchScrape(ctx context.Context, query string, n int) ([]searchHit, error) {
	form := url.Values{"q": {query}}
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://html.duckduckgo.com/html/", strings.NewReader(form.Encode()))
	req.Header.Set("User-Agent", wsUA)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "text/html")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("DuckDuckGo HTTP %d", resp.StatusCode)
	}
	buf := new(bytes.Buffer)
	buf.ReadFrom(resp.Body)
	hits := parseDuckDuckGoHTML(buf.String())
	if len(hits) > n {
		hits = hits[:n]
	}
	return hits, nil
}

var (
	ddgLinkRe    = regexp.MustCompile(`(?is)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	ddgSnippetRe = regexp.MustCompile(`(?is)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>`)
	tagRe        = regexp.MustCompile(`<[^>]+>`)
	wsRe         = regexp.MustCompile(`\s+`)
	uddgRe       = regexp.MustCompile(`[?&]uddg=([^&]+)`)
)

func ddgStripTags(s string) string {
	s = tagRe.ReplaceAllString(s, "")
	r := strings.NewReplacer(
		"&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">",
		"&quot;", `"`, "&#x27;", "'", "&#39;", "'",
	)
	s = r.Replace(s)
	return strings.TrimSpace(wsRe.ReplaceAllString(s, " "))
}

func decodeDdgURL(href string) string {
	if m := uddgRe.FindStringSubmatch(href); m != nil {
		if dec, err := url.QueryUnescape(m[1]); err == nil {
			return dec
		}
		return m[1]
	}
	if strings.HasPrefix(href, "//") {
		return "https:" + href
	}
	return href
}

// parseDuckDuckGoHTML parses the DuckDuckGo HTML result page into hits. Exported-ish
// (package-visible) so the unit test can verify it against a captured fixture.
func parseDuckDuckGoHTML(html string) []searchHit {
	var hits []searchHit
	links := ddgLinkRe.FindAllStringSubmatchIndex(html, -1)
	snips := ddgSnippetRe.FindAllStringSubmatchIndex(html, -1)
	for _, lm := range links {
		href := html[lm[2]:lm[3]]
		title := ddgStripTags(html[lm[4]:lm[5]])
		u := decodeDdgURL(href)
		if title == "" || !(strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")) {
			continue
		}
		content := ""
		for _, sm := range snips {
			if sm[0] > lm[0] { // first snippet appearing after this link
				content = ddgStripTags(html[sm[2]:sm[3]])
				break
			}
		}
		hits = append(hits, searchHit{Title: title, URL: u, Content: content})
	}
	return hits
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
				Title:    query,
				Output:   "Web search is disabled (WEBSEARCH_PROVIDER=none). Proceed using your existing knowledge.",
				Metadata: map[string]any{"error": "disabled"},
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
		switch provider {
		case "tavily":
			hits, err = searchTavily(cctx, query, n, key)
		case "exa":
			hits, err = searchExa(cctx, query, n, key)
		default:
			hits, err = searchScrape(cctx, query, n)
		}
		if err != nil {
			hint := ""
			if provider == "scrape" {
				hint = " (keyless DuckDuckGo scrape — set TAVILY_API_KEY for reliable search)"
			}
			return Result{Title: query, Output: "Web search failed: " + err.Error() + hint, Metadata: map[string]any{"error": "search_failed", "provider": provider}}, nil
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
