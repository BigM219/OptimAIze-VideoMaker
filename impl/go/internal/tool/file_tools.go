// File tools (Go parity of read.ts, write.ts, list-files.ts, invalid.ts).
// See docs/harness-design.md §5.1. Wrap the already-jailed Store file ops.
package tool

import (
	"fmt"
	"strings"
)

const defaultReadLimit = 2000

// ReadTool reads a project file (line-numbered) or lists a directory.
var ReadTool = Def{
	ID: "read",
	Description: "Read a project file (line-numbered) or list a directory. Use before editing so you can reference exact lines. " +
		"Paths are relative to the project root (e.g. src/scenes/Intro.tsx).",
	Parameters: []Param{
		{Name: "filePath", Type: "string", Description: "Relative path to the file or directory", Required: true},
		{Name: "offset", Type: "number", Description: "1-based line to start from (file only)"},
		{Name: "limit", Type: "number", Description: fmt.Sprintf("Max lines to read (default %d)", defaultReadLimit)},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		fp, err := reqString(args, "filePath")
		if err != nil {
			return nil, err
		}
		norm, err := assertProjectPath(fp)
		if err != nil {
			return nil, err
		}
		offset, _, err := optNumber(args, "offset")
		if err != nil {
			return nil, err
		}
		limit, hasLimit, err := optNumber(args, "limit")
		if err != nil {
			return nil, err
		}
		out := map[string]any{"filePath": norm, "offset": offset}
		if hasLimit {
			out["limit"] = limit
		}
		return out, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		fp := args["filePath"].(string)

		// Directory listing: if ListFiles returns something that isn't exactly
		// this one file, treat it as a directory.
		if entries, err := ctx.Store.ListFiles(ctx.ProjectID, fp); err == nil {
			if len(entries) != 1 || entries[0].Path != fp || entries[0].IsDir {
				var lines []string
				for _, e := range entries {
					if strings.Contains(e.Path, "node_modules") {
						continue
					}
					if e.IsDir {
						lines = append(lines, e.Path+"/")
					} else {
						lines = append(lines, e.Path)
					}
				}
				body := fmt.Sprintf("<path>%s</path>\n<type>directory</type>\n<entries>\n%s\n</entries>", fp, strings.Join(lines, "\n"))
				return Result{Title: fp, Output: body, Metadata: map[string]any{"entries": len(lines)}}, nil
			}
		}

		content, err := ctx.Store.ReadFile(ctx.ProjectID, fp)
		if err != nil {
			return Result{Title: fp, Output: "File not found: " + fp, Metadata: map[string]any{"error": "not_found"}}, nil
		}
		all := strings.Split(content, "\n")
		offset := 1
		if o, ok := args["offset"].(float64); ok && o >= 1 {
			offset = int(o)
		}
		limit := defaultReadLimit
		if l, ok := args["limit"].(float64); ok && l > 0 {
			limit = int(l)
		}
		if offset > len(all) && !(len(all) == 1 && all[0] == "") {
			return Result{Title: fp, Output: fmt.Sprintf("Offset %d is out of range for this file (%d lines).", offset, len(all)), Metadata: map[string]any{"error": "offset_range"}}, nil
		}
		end := offset - 1 + limit
		if end > len(all) {
			end = len(all)
		}
		var b strings.Builder
		for i := offset - 1; i < end; i++ {
			line := all[i]
			if len(line) > maxLineLength {
				line = line[:maxLineLength] + " … (line truncated)"
			}
			fmt.Fprintf(&b, "%d: %s\n", i+1, line)
		}
		lastLine := end
		var trailer string
		if lastLine >= len(all) {
			trailer = fmt.Sprintf("(End of file - %d lines)", len(all))
		} else {
			trailer = fmt.Sprintf("(Showing lines %d-%d of %d. Use offset=%d to continue.)", offset, lastLine, len(all), lastLine+1)
		}
		body := fmt.Sprintf("<path>%s</path>\n<type>file</type>\n<content>\n%s%s\n</content>", fp, b.String(), trailer)
		out, truncated, outputPath := truncateOutput(ctx, "read", body, outputCap)
		return Result{Title: fp, Output: out, Truncated: truncated, OutputPath: outputPath, Metadata: map[string]any{"lines": len(all), "offset": offset}}, nil
	},
}

// WriteTool creates or overwrites a project file.
var WriteTool = Def{
	ID:          "write",
	Description: "Create or overwrite a project file with the given content. Path must be under src/, public/, or out/. Prefer `edit` for small changes — write sends the whole file.",
	Mutating:    true,
	Parameters: []Param{
		{Name: "filePath", Type: "string", Description: "Relative path to write (e.g. src/scenes/Intro.tsx)", Required: true},
		{Name: "content", Type: "string", Description: "Full file content", Required: true},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		fp, err := reqString(args, "filePath")
		if err != nil {
			return nil, err
		}
		norm, err := assertProjectPath(fp)
		if err != nil {
			return nil, err
		}
		content, ok := args["content"].(string)
		if !ok {
			return nil, validationErr("%q is required and must be a string.", "content")
		}
		return map[string]any{"filePath": norm, "content": content}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		fp := args["filePath"].(string)
		content := args["content"].(string)
		_, readErr := ctx.Store.ReadFile(ctx.ProjectID, fp)
		existed := readErr == nil
		if err := ctx.Store.WriteFile(ctx.ProjectID, fp, content); err != nil {
			return Result{}, err
		}
		ctx.LogStep("scene", "Wrote "+fp, StepExtra{Kind: "write_file", Path: fp, Content: content})
		return Result{
			Title:    fp,
			Output:   fmt.Sprintf("Wrote file successfully (%d chars).", len(content)),
			Metadata: map[string]any{"filePath": fp, "exists": existed},
		}, nil
	},
}

// ListFilesTool lists the project source tree.
var ListFilesTool = Def{
	ID:          "list_files",
	Description: "List project files under a directory (default the project root). Use to orient before reading.",
	Parameters: []Param{
		{Name: "path", Type: "string", Description: "Directory to list (default project root)"},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		p, err := optString(args, "path")
		if err != nil {
			return nil, err
		}
		if p == "" {
			p = "src"
		}
		return map[string]any{"path": p}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		root := args["path"].(string)
		files := walkFiles(ctx, root, 5000)
		if len(files) == 0 {
			return Result{Title: root, Output: "No files found", Metadata: map[string]any{"count": 0}}, nil
		}
		return Result{Title: root, Output: strings.Join(files, "\n"), Metadata: map[string]any{"count": len(files)}}, nil
	},
}

// InvalidTool is the sentinel returned when the model calls an unknown tool.
var InvalidTool = Def{
	ID:          "invalid",
	Description: "Do not use",
	Parameters:  nil,
	Validate:    func(args map[string]any) (map[string]any, error) { return args, nil },
	Execute: func(args map[string]any, _ *Context) (Result, error) {
		errMsg, _ := args["error"].(string)
		return Result{Title: "Invalid Tool", Output: "The arguments provided to the tool are invalid: " + errMsg}, nil
	},
}
