// JSON-block tool-call protocol (Go parity of tool/protocol.ts).
// See docs/harness-design.md §3, §7. The LLM emits a fenced ```tool_calls```
// block; we parse it (with a tolerance ladder for slightly malformed JSON) and
// render results back as a ```tool_results``` block.
package tool

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

func nowNano() int64 { return time.Now().UnixNano() }

// ParsedTurn is the outcome of parsing one model response.
type ParsedTurn struct {
	Done       bool
	Summary    string
	Calls      []Call
	ParseError string // set when a block was present but unparseable
}

var blockRe = regexp.MustCompile("(?s)```tool_calls\\s*\\n(.*?)```")

// looseJSONRepair fixes common JSON mistakes before json.Unmarshal: block/line
// comments and trailing commas. It does not try to fix unbalanced quotes.
var (
	blockCommentRe = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineCommentRe  = regexp.MustCompile(`(^|\s)//[^\n]*`)
	trailingComma  = regexp.MustCompile(`,(\s*[}\]])`)
)

func looseJSONRepair(s string) string {
	out := blockCommentRe.ReplaceAllString(s, "")
	out = lineCommentRe.ReplaceAllString(out, "$1")
	out = trailingComma.ReplaceAllString(out, "$1")
	return strings.TrimSpace(out)
}

func tryParse(raw string) (map[string]any, error) {
	var v map[string]any
	if err := json.Unmarshal([]byte(raw), &v); err == nil {
		return v, nil
	}
	if err := json.Unmarshal([]byte(looseJSONRepair(raw)), &v); err != nil {
		return nil, err
	}
	return v, nil
}

// ParseToolCalls extracts and parses the tool_calls block from a model response.
func ParseToolCalls(resp string) ParsedTurn {
	m := blockRe.FindStringSubmatch(resp)
	if m == nil {
		return ParsedTurn{} // no block — director treats as idle
	}
	obj, err := tryParse(m[1])
	if err != nil {
		return ParsedTurn{
			ParseError: fmt.Sprintf("The tool_calls block was not valid JSON: %v. "+
				"Return exactly one ```tool_calls``` block whose body is a JSON object "+
				`with either {"calls":[...]} or {"done":true,"summary":"..."}.`, err),
		}
	}
	if d, ok := obj["done"].(bool); ok && d {
		summary, _ := obj["summary"].(string)
		return ParsedTurn{Done: true, Summary: summary}
	}
	rawCalls, _ := obj["calls"].([]any)
	var calls []Call
	for _, rc := range rawCalls {
		cm, ok := rc.(map[string]any)
		if !ok {
			continue
		}
		toolName, ok := cm["tool"].(string)
		if !ok {
			continue
		}
		args, _ := cm["args"].(map[string]any)
		if args == nil {
			args = map[string]any{}
		}
		calls = append(calls, Call{Tool: toolName, Args: args})
	}
	if len(calls) == 0 {
		return ParsedTurn{
			ParseError: `The tool_calls block had no usable calls. Each call needs a string "tool" ` +
				`and an "args" object, e.g. {"calls":[{"tool":"read","args":{"filePath":"src/Root.tsx"}}]}.`,
		}
	}
	return ParsedTurn{Calls: calls}
}

// RenderToolResults renders executed results as a ```tool_results``` block.
func RenderToolResults(results []CallResult) string {
	type wire struct {
		Tool       string `json:"tool"`
		OK         bool   `json:"ok"`
		Output     string `json:"output"`
		Truncated  bool   `json:"truncated,omitempty"`
		OutputPath string `json:"outputPath,omitempty"`
	}
	out := struct {
		Results []wire `json:"results"`
	}{}
	for _, r := range results {
		out.Results = append(out.Results, wire{r.Tool, r.OK, r.Output, r.Truncated, r.OutputPath})
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	return "```tool_results\n" + string(b) + "\n```"
}
