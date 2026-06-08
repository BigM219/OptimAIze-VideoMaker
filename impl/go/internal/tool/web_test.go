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

func TestWebSearchNotConfigured(t *testing.T) {
	// Ensure no provider key is visible to this test.
	os.Unsetenv("WEBSEARCH_PROVIDER")
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
	if res.Metadata["error"] != "not_configured" {
		t.Errorf("expected not_configured, got metadata=%v", res.Metadata)
	}
	if !strings.Contains(res.Output, "not configured") {
		t.Errorf("output should explain it's not configured: %q", res.Output)
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
