// Unit tests for the web tools (Go parity of verify-harness-web.mjs).
// Covers webfetch arg validation + the HTML→markdown/text converter, and
// websearch's not-configured path. No real network calls.
package tool

import (
	"os"
	"strings"
	"testing"
)

func TestWebFetchValidate(t *testing.T) {
	// rejects non-http url
	if _, err := WebFetchTool.Validate(map[string]any{"url": "ftp://x"}); err == nil {
		t.Error("expected non-http url to be rejected")
	}
	// requires url
	if _, err := WebFetchTool.Validate(map[string]any{}); err == nil {
		t.Error("expected missing url to be rejected")
	}
	// rejects bad format
	if _, err := WebFetchTool.Validate(map[string]any{"url": "https://x", "format": "pdf"}); err == nil {
		t.Error("expected bad format to be rejected")
	}
	// defaults format to markdown
	v, err := WebFetchTool.Validate(map[string]any{"url": "https://x"})
	if err != nil {
		t.Fatalf("valid args errored: %v", err)
	}
	if v["format"] != "markdown" {
		t.Errorf("format default = %v, want markdown", v["format"])
	}
}

func TestHTMLToMarkdown(t *testing.T) {
	html := `<html><head><style>x{}</style></head><body>
<h1>Title</h1><p>Hello <a href="https://e.com">link</a>.</p>
<pre>code block</pre><ul><li>one</li><li>two</li></ul>
<script>evil()</script></body></html>`
	md := htmlToMarkdown(html)
	checks := map[string]string{
		"# Title":              "heading",
		"[link](https://e.com)": "link",
		"```":                  "code fence",
		"- one":                "list item",
	}
	for sub, what := range checks {
		if !strings.Contains(md, sub) {
			t.Errorf("markdown missing %s (%q)\n--- got ---\n%s", what, sub, md)
		}
	}
	if strings.Contains(md, "evil()") {
		t.Error("script content leaked into markdown")
	}

	txt := htmlToText(html)
	if !strings.Contains(txt, "Hello") || strings.Contains(txt, "<p>") {
		t.Errorf("text conversion wrong: %q", txt)
	}
	if strings.Contains(txt, "evil()") {
		t.Error("script content leaked into text")
	}
}

func TestWebSearchDisabled(t *testing.T) {
	// WEBSEARCH_PROVIDER=none disables search without any network call.
	os.Setenv("WEBSEARCH_PROVIDER", "none")
	defer os.Unsetenv("WEBSEARCH_PROVIDER")
	os.Unsetenv("TAVILY_API_KEY")
	os.Unsetenv("EXA_API_KEY")

	if _, err := WebSearchTool.Validate(map[string]any{}); err == nil {
		t.Error("expected missing query to be rejected")
	}
	v, err := WebSearchTool.Validate(map[string]any{"query": "remotion docs"})
	if err != nil {
		t.Fatalf("valid query errored: %v", err)
	}
	s := newFakeStore()
	res, err := WebSearchTool.Execute(v, newCtx(s, &fakeBackend{}))
	if err != nil {
		t.Fatalf("execute errored: %v", err)
	}
	if res.Metadata["error"] != "disabled" {
		t.Errorf("expected disabled, got metadata=%v", res.Metadata)
	}
}

func TestResolveProviderScrapeDefault(t *testing.T) {
	// With no key and no explicit choice, the provider falls back to keyless scrape.
	os.Unsetenv("WEBSEARCH_PROVIDER")
	os.Unsetenv("TAVILY_API_KEY")
	os.Unsetenv("EXA_API_KEY")
	if p, _ := resolveProvider(); p != "scrape" {
		t.Errorf("expected scrape fallback, got %q", p)
	}
	// An explicit key takes precedence.
	os.Setenv("TAVILY_API_KEY", "k")
	defer os.Unsetenv("TAVILY_API_KEY")
	if p, _ := resolveProvider(); p != "tavily" {
		t.Errorf("expected tavily when key present, got %q", p)
	}
}

func TestParseDuckDuckGoHTML(t *testing.T) {
	// A minimal fixture mimicking the DuckDuckGo HTML result layout: a result__a
	// link wrapping the title (href via the uddg= redirect) + a result__snippet.
	fixture := `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.remotion.dev%2Fdocs%2Fuse-current-frame&rut=x">useCurrentFrame() | Remotion</a>
  <a class="result__snippet" href="//x">Returns the <b>current frame</b> of the video.</a>
</div>
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Second &amp; Result</a>
  <a class="result__snippet" href="//y">Snippet two.</a>
</div>`
	hits := parseDuckDuckGoHTML(fixture)
	if len(hits) != 2 {
		t.Fatalf("expected 2 hits, got %d", len(hits))
	}
	if hits[0].URL != "https://www.remotion.dev/docs/use-current-frame" {
		t.Errorf("uddg decode failed: %q", hits[0].URL)
	}
	if hits[0].Title != "useCurrentFrame() | Remotion" {
		t.Errorf("title parse failed: %q", hits[0].Title)
	}
	if !strings.Contains(hits[0].Content, "current frame") {
		t.Errorf("snippet parse failed: %q", hits[0].Content)
	}
	if hits[1].Title != "Second & Result" {
		t.Errorf("entity decode in title failed: %q", hits[1].Title)
	}
	if hits[1].URL != "https://example.com/page" {
		t.Errorf("second url decode failed: %q", hits[1].URL)
	}
}

func TestRegistryHasWebTools(t *testing.T) {
	r := NewRegistry()
	ids := map[string]bool{}
	for _, id := range r.IDs() {
		ids[id] = true
	}
	for _, want := range []string{"webfetch", "websearch"} {
		if !ids[want] {
			t.Errorf("registry missing %s", want)
		}
	}
	docs := r.RenderDocs()
	if !strings.Contains(docs, "webfetch") || !strings.Contains(docs, "websearch") {
		t.Error("RenderDocs missing web tools")
	}
}
