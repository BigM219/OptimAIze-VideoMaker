// webfetch — fetch a URL and return its content as markdown/text/html.
// Go parity of webfetch.ts. Runs in the backend process (has network), not the
// sandbox. Hand-rolled HTML→markdown (no dependency).
package tool

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	webfetchDefaultTimeoutS = 30
	webfetchMaxTimeoutS     = 120
	webfetchMaxBytes        = 5 * 1024 * 1024 // 5 MB
	webfetchUA              = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

var (
	reScriptish = regexp.MustCompile(`(?is)<(script|style|noscript|iframe|svg|head)[\s\S]*?</(script|style|noscript|iframe|svg|head)>`)
	reHeading   = regexp.MustCompile(`(?is)<h([1-6])[^>]*>(.*?)</h[1-6]>`)
	rePre       = regexp.MustCompile(`(?is)<pre[^>]*>(.*?)</pre>`)
	reCode      = regexp.MustCompile(`(?is)<code[^>]*>(.*?)</code>`)
	reAnchor    = regexp.MustCompile(`(?is)<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)</a>`)
	reLi        = regexp.MustCompile(`(?is)<li[^>]*>(.*?)</li>`)
	reBlockEnd  = regexp.MustCompile(`(?is)</(p|div|section|article|header|footer|ul|ol|tr|h[1-6])>`)
	reBr        = regexp.MustCompile(`(?is)<br[^>]*>`)
	reAnyTag    = regexp.MustCompile(`(?s)<[^>]+>`)
	reEntNum    = regexp.MustCompile(`&#(\d+);`)
	reSpaces    = regexp.MustCompile(`[ \t]+`)
	reBlanks    = regexp.MustCompile(`\n{3,}`)
	reWS        = regexp.MustCompile(`\s+`)
	reDoctype   = regexp.MustCompile(`(?is)^\s*<(!doctype|html)`)
)

func decodeEntities(s string) string {
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", "\"")
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = reEntNum.ReplaceAllStringFunc(s, func(m string) string {
		var n int
		fmt.Sscanf(m, "&#%d;", &n)
		if n > 0 && n < 0x10FFFF {
			return string(rune(n))
		}
		return m
	})
	return s
}

func stripFragment(html string) string {
	return strings.TrimSpace(reWS.ReplaceAllString(decodeEntities(reAnyTag.ReplaceAllString(html, "")), " "))
}

func htmlToText(html string) string {
	s := reScriptish.ReplaceAllString(html, "")
	s = reAnyTag.ReplaceAllString(s, " ")
	s = decodeEntities(s)
	s = reSpaces.ReplaceAllString(s, " ")
	s = reBlanks.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

func htmlToMarkdown(html string) string {
	s := reScriptish.ReplaceAllString(html, "")
	s = reHeading.ReplaceAllStringFunc(s, func(m string) string {
		g := reHeading.FindStringSubmatch(m)
		n := int(g[1][0] - '0')
		return "\n\n" + strings.Repeat("#", n) + " " + stripFragment(g[2]) + "\n\n"
	})
	s = rePre.ReplaceAllStringFunc(s, func(m string) string {
		g := rePre.FindStringSubmatch(m)
		return "\n\n```\n" + decodeEntities(stripFragment(g[1])) + "\n```\n\n"
	})
	s = reCode.ReplaceAllStringFunc(s, func(m string) string {
		g := reCode.FindStringSubmatch(m)
		return "`" + stripFragment(g[1]) + "`"
	})
	s = reAnchor.ReplaceAllStringFunc(s, func(m string) string {
		g := reAnchor.FindStringSubmatch(m)
		text := stripFragment(g[2])
		if text == "" {
			return ""
		}
		return "[" + text + "](" + g[1] + ")"
	})
	s = reLi.ReplaceAllStringFunc(s, func(m string) string {
		g := reLi.FindStringSubmatch(m)
		return "\n- " + stripFragment(g[1])
	})
	s = reBlockEnd.ReplaceAllString(s, "\n\n")
	s = reBr.ReplaceAllString(s, "\n")
	s = reAnyTag.ReplaceAllString(s, "")
	s = decodeEntities(s)
	s = reSpaces.ReplaceAllString(s, " ")
	s = reBlanks.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}

// WebFetchTool fetches a URL and returns markdown/text/html.
var WebFetchTool = Def{
	ID: "webfetch",
	Description: "Fetch a URL and return its content as markdown (default), text, or html. " +
		"Use to pull in external reference material (API docs, examples). URL must be http(s). Large pages are truncated.",
	Parameters: []Param{
		{Name: "url", Type: "string", Description: "The URL to fetch (must start with http:// or https://)", Required: true},
		{Name: "format", Type: "string", Description: "markdown | text | html (default markdown)"},
		{Name: "timeout", Type: "number", Description: fmt.Sprintf("Timeout in seconds (max %d)", webfetchMaxTimeoutS)},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		url, err := reqString(args, "url")
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(strings.ToLower(url), "http://") && !strings.HasPrefix(strings.ToLower(url), "https://") {
			return nil, validationErr("%q must start with http:// or https://", "url")
		}
		format, err := optString(args, "format")
		if err != nil {
			return nil, err
		}
		if format == "" {
			format = "markdown"
		}
		if format != "markdown" && format != "text" && format != "html" {
			return nil, validationErr("%q must be one of: markdown, text, html.", "format")
		}
		timeout, _, err := optNumber(args, "timeout")
		if err != nil {
			return nil, err
		}
		return map[string]any{"url": url, "format": format, "timeout": timeout}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		url := args["url"].(string)
		format := args["format"].(string)
		timeoutS := webfetchDefaultTimeoutS
		if t, ok := args["timeout"].(float64); ok && t > 0 {
			timeoutS = int(t)
		}
		if timeoutS > webfetchMaxTimeoutS {
			timeoutS = webfetchMaxTimeoutS
		}

		cctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutS)*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cctx, "GET", url, nil)
		req.Header.Set("User-Agent", webfetchUA)
		req.Header.Set("Accept", "text/html,text/markdown,text/plain,*/*")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return Result{Title: url, Output: "Fetch failed: " + err.Error(), Metadata: map[string]any{"error": "fetch_failed"}}, nil
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return Result{Title: url, Output: fmt.Sprintf("HTTP %d fetching %s", resp.StatusCode, url), Metadata: map[string]any{"error": "http_error", "status": resp.StatusCode}}, nil
		}
		limited := io.LimitReader(resp.Body, webfetchMaxBytes+1)
		rawBytes, _ := io.ReadAll(limited)
		if len(rawBytes) > webfetchMaxBytes {
			return Result{Title: url, Output: fmt.Sprintf("Response too large (exceeds %d bytes).", webfetchMaxBytes), Metadata: map[string]any{"error": "too_large"}}, nil
		}
		raw := string(rawBytes)
		contentType := resp.Header.Get("Content-Type")

		isHTML := strings.Contains(contentType, "html") || reDoctype.MatchString(raw)
		var body string
		switch {
		case !isHTML || format == "html":
			body = raw
		case format == "text":
			body = htmlToText(raw)
		default:
			body = htmlToMarkdown(raw)
		}

		out, truncated, outputPath := truncateOutput(ctx, "webfetch", body, outputCap)
		return Result{
			Title:      fmt.Sprintf("%s (%s)", url, contentType),
			Output:     out,
			Truncated:  truncated,
			OutputPath: outputPath,
			Metadata:   map[string]any{"url": url, "format": format, "contentType": contentType},
		}, nil
	},
}
