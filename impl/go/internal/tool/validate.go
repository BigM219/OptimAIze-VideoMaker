// Shared arg-validation + path helpers (Go parity of tool/validate.ts).
package tool

import (
	"math"
	"strconv"
	"strings"
)

func reqString(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok {
		return "", validationErr("%q is required and must be a non-empty string.", key)
	}
	s, ok := v.(string)
	if !ok || s == "" {
		return "", validationErr("%q is required and must be a non-empty string.", key)
	}
	return s, nil
}

func optString(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok || v == nil {
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", validationErr("%q must be a string.", key)
	}
	return s, nil
}

// optNumber tolerates models sending numbers as JSON strings.
func optNumber(args map[string]any, key string) (float64, bool, error) {
	v, ok := args[key]
	if !ok || v == nil {
		return 0, false, nil
	}
	switch n := v.(type) {
	case float64:
		if math.IsInf(n, 0) || math.IsNaN(n) {
			return 0, false, validationErr("%q must be a finite number.", key)
		}
		return n, true, nil
	case int:
		return float64(n), true, nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return 0, false, validationErr("%q must be a number.", key)
		}
		return f, true, nil
	default:
		return 0, false, validationErr("%q must be a number.", key)
	}
}

func optBool(args map[string]any, key string) (bool, error) {
	v, ok := args[key]
	if !ok || v == nil {
		return false, nil
	}
	switch b := v.(type) {
	case bool:
		return b, nil
	case string:
		if b == "true" {
			return true, nil
		}
		if b == "false" {
			return false, nil
		}
	}
	return false, validationErr("%q must be a boolean.", key)
}

// writablePrefixes mirrors the TS jail: tools may only touch these subtrees.
var writablePrefixes = []string{"src/", "public/", "out/"}

func assertProjectPath(p string) (string, error) {
	norm := strings.ReplaceAll(p, "\\", "/")
	norm = strings.TrimPrefix(norm, "./")
	if strings.HasPrefix(norm, "/") || strings.Contains(norm, "..") {
		return "", validationErr("Path %q must be relative to the project root with no \"..\".", p)
	}
	for _, pre := range writablePrefixes {
		if strings.HasPrefix(norm, pre) {
			return norm, nil
		}
	}
	return "", validationErr("Path %q must be under one of: %s.", p, strings.Join(writablePrefixes, ", "))
}

// assertReadablePath is the looser check for read-only tools (read): any path
// relative to the project root is allowed (e.g. package.json, tsconfig.json) so
// the agent can understand the project, but absolute paths and ".." escapes are
// still rejected. Write/edit keep the stricter assertProjectPath.
func assertReadablePath(p string) (string, error) {
	norm := strings.ReplaceAll(p, "\\", "/")
	norm = strings.TrimPrefix(norm, "./")
	if strings.HasPrefix(norm, "/") || strings.Contains(norm, "..") {
		return "", validationErr("Path %q must be relative to the project root with no \"..\".", p)
	}
	return norm, nil
}
