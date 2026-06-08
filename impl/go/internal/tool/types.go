// Harness tool contract (Go parity of impl/ts/src/tool/types.ts).
// See docs/harness-design.md §4. The LLM client only returns text, so tools are
// invoked via a JSON-block protocol (protocol.go) and dispatched through a
// lightweight registry (registry.go). To avoid an import cycle with the
// projects package, the tool context depends on small structural interfaces
// rather than the concrete *projects.Store / *sandbox.ProcessBackend.
package tool

import (
	"fmt"

	"optimaize-videomaker-go/internal/types"
)

// Store is the subset of *projects.Store the file tools need (already jailed).
type Store interface {
	ReadFile(pid, rel string) (string, error)
	WriteFile(pid, rel, content string) error
	ListFiles(pid, rel string) ([]types.FileEntry, error)
}

// Backend is the subset of *sandbox.ProcessBackend the exec tools need (caged).
type Backend interface {
	Exec(id, command, cwd string, env map[string]string, timeoutS float64) (types.ExecResult, error)
}

// StepExtra mirrors the optional rich fields of projects.Step so a tool can log
// a transcript step without importing the projects package.
type StepExtra struct {
	Kind     string
	Path     string
	Content  string
	Command  string
	ExitCode *int
	Output   string
}

// Context is what every tool's Execute receives.
type Context struct {
	ProjectID string
	Store     Store
	Backend   Backend
	SandboxID string
	Log       func(phase, detail string, extra StepExtra)
}

// LogStep is a nil-safe helper so tools can always call ctx.LogStep(...).
func (c *Context) LogStep(phase, detail string, extra StepExtra) {
	if c.Log != nil {
		c.Log(phase, detail, extra)
	}
}

// Result is what a tool's Execute returns. Output is the text fed back to the
// LLM; the registry truncates it and fills Truncated/OutputPath.
type Result struct {
	Title      string
	Output     string
	Metadata   map[string]any
	Truncated  bool
	OutputPath string
}

// Param is a minimal JSON-schema-ish descriptor for validation + rendering the
// tool docs injected into the system prompt.
type Param struct {
	Name        string
	Type        string // string|number|boolean|array|object
	Description string
	Required    bool
	Items       string // for arrays: element-shape hint (docs only)
}

// Def is a single tool. Func fields keep it close to the TS object style.
type Def struct {
	ID          string
	Description string
	Parameters  []Param
	Mutating    bool // write/edit-style tools trigger a post-turn diagnostics pass
	// Validate coerces/validates raw args; a ValidationError is shown to the model.
	Validate func(args map[string]any) (map[string]any, error)
	Execute  func(args map[string]any, ctx *Context) (Result, error)
}

// ValidationError is returned by Validate when args don't satisfy the schema;
// the registry turns it into an ok:false result asking the model to rewrite.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func validationErr(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// Call is one parsed tool invocation from a tool_calls block.
type Call struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
}

// CallResult is the executed result, ready to render back to the model.
type CallResult struct {
	Tool       string         `json:"tool"`
	OK         bool           `json:"ok"`
	Output     string         `json:"output"`
	Title      string         `json:"-"`
	Metadata   map[string]any `json:"-"`
	Truncated  bool           `json:"truncated,omitempty"`
	OutputPath string         `json:"outputPath,omitempty"`
}
