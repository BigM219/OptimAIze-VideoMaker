// VideoMaker project store + lifecycle + concept-driven director loop (Go).
// Mirrors the TS projects.ts + director.ts: scaffold a Remotion sandbox, turn a
// concept into a complete multi-scene video, launch Studio, code-aware chat.
package projects

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"optimaize-videomaker-go/internal/sandbox"
	"optimaize-videomaker-go/internal/types"
)

type Scene struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	DurationInFrames int    `json:"durationInFrames"`
	Narration        string `json:"narration"`
	Visual           string `json:"visual"`
	// Per-scene lifecycle so the UI can review each slide live in Studio as soon
	// as its code is written. Each scene is its own Remotion composition, so
	// Studio renders it directly from code (hot-reload) — no per-scene mp4.
	// "ready" = code written and registered in Studio; "error" = compile/repair
	// pending without blocking the other slides.
	Status      string `json:"status,omitempty"`      // pending|writing|ready|error
	RenderError string `json:"render_error,omitempty"`
}
type Storyboard struct {
	Title  string  `json:"title"`
	FPS    int     `json:"fps"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	Scenes []Scene `json:"scenes"`
}
type Step struct {
	Index     int     `json:"index"`
	Timestamp float64 `json:"timestamp"`
	Phase     string  `json:"phase"`
	Detail    string  `json:"detail"`
	// Optional rich fields so the UI can render a coding-agent transcript.
	Kind     string `json:"kind,omitempty"`     // plan|write_file|command|command_output|repair|info|error
	Path     string `json:"path,omitempty"`     // write_file
	Content  string `json:"content,omitempty"`  // write_file: code written (capped)
	Command  string `json:"command,omitempty"`  // command
	ExitCode *int   `json:"exit_code,omitempty"` // command_output
	Output   string `json:"output,omitempty"`   // command_output (capped)
}

// stepFieldCap bounds large transcript payloads so the polled JSON stays small.
const stepFieldCap = 4000

func capField(s string) string {
	if len(s) <= stepFieldCap {
		return s
	}
	return s[:stepFieldCap] + fmt.Sprintf("\n… (%d more chars)", len(s)-stepFieldCap)
}
type Project struct {
	ID         string            `json:"id"`
	SandboxID  string            `json:"sandbox_id"`
	Prompt     string            `json:"prompt"`
	Reqs       string            `json:"requirements"`
	Goals      string            `json:"goals"`
	State      string            `json:"state"`
	StudioURL  string            `json:"studio_url"`
	Storyboard *Storyboard       `json:"storyboard"`
	ExportPath string            `json:"export_path"`
	Error      string            `json:"error"`
	Steps      []Step            `json:"steps"`
	Chat       []map[string]string `json:"chat"`
	CreatedAt  float64           `json:"created_at"`
	UpdatedAt  float64           `json:"updated_at"`
	mu         sync.Mutex
}

type Store struct {
	mu         sync.Mutex
	projects   map[string]*Project
	mgr        *sandbox.Manager
	studioPort int
}

func NewStore(mgr *sandbox.Manager) *Store {
	return &Store{projects: map[string]*Project{}, mgr: mgr, studioPort: 3100}
}

func now() float64 { return float64(time.Now().UnixNano()) / 1e9 }
func id(p string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return p + hex.EncodeToString(b)
}

func (s *Store) step(p *Project, phase, detail string) {
	s.stepRich(p, Step{Phase: phase, Detail: detail})
}

// stepRich appends a step with optional rich transcript fields (capped).
func (s *Store) stepRich(p *Project, st Step) {
	p.mu.Lock()
	st.Index = len(p.Steps)
	st.Timestamp = now()
	st.Content = capField(st.Content)
	st.Output = capField(st.Output)
	p.Steps = append(p.Steps, st)
	p.UpdatedAt = now()
	p.mu.Unlock()
}

func (s *Store) Get(pid string) (*Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.projects[pid]
	return p, ok
}
func (s *Store) List() []*Project {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Project, 0, len(s.projects))
	for _, p := range s.projects {
		out = append(out, p)
	}
	return out
}
func (s *Store) Manager() *sandbox.Manager { return s.mgr }

func (s *Store) Create(prompt, reqs, goals string) *Project {
	p := &Project{
		ID: id("prj_"), Prompt: prompt, Reqs: reqs, Goals: goals, State: "pending",
		Steps: []Step{}, Chat: []map[string]string{}, CreatedAt: now(), UpdatedAt: now(),
	}
	s.mu.Lock()
	s.projects[p.ID] = p
	s.mu.Unlock()
	go s.scaffold(p)
	return p
}

func (s *Store) scaffold(p *Project) {
	p.State = "scaffolding"
	info, err := s.mgr.Create("process", nil, nil)
	if err != nil {
		p.State = "failed"
		p.Error = err.Error()
		return
	}
	p.SandboxID = info.SandboxID
	cmd1 := "npx --yes create-video@latest --yes --blank ."
	s.stepRich(p, Step{Phase: "scaffold", Detail: "Scaffolding a blank Remotion project", Kind: "command", Command: cmd1})
	r, _ := s.mgr.Backend().Exec(p.SandboxID, cmd1, "", nil, 600)
	ec1 := r.ExitCode
	s.stepRich(p, Step{Phase: "scaffold", Detail: fmt.Sprintf("create-video exited %d", ec1), Kind: "command_output", ExitCode: &ec1, Output: r.Stdout + "\n" + r.Stderr})
	if r.ExitCode != 0 {
		p.State = "failed"
		p.Error = "scaffold failed: " + trim(r.Stderr, 300)
		return
	}
	cmd2 := "npm install --no-audit --no-fund"
	s.stepRich(p, Step{Phase: "install", Detail: "Installing dependencies", Kind: "command", Command: cmd2})
	r, _ = s.mgr.Backend().Exec(p.SandboxID, cmd2, "", nil, 1200)
	ec2 := r.ExitCode
	s.stepRich(p, Step{Phase: "install", Detail: fmt.Sprintf("npm install exited %d", ec2), Kind: "command_output", ExitCode: &ec2, Output: r.Stdout + "\n" + r.Stderr})
	if r.ExitCode != 0 {
		p.State = "failed"
		p.Error = "npm install failed: " + trim(r.Stderr, 300)
		return
	}
	p.State = "ready"
	s.stepRich(p, Step{Phase: "ready", Detail: "Project scaffolded and dependencies installed.", Kind: "info"})
}

func (s *Store) LaunchStudio(pid string) (string, int, error) {
	p, ok := s.Get(pid)
	if !ok {
		return "", 0, fmt.Errorf("project not found")
	}
	if p.StudioURL != "" {
		return p.StudioURL, 0, nil
	}
	s.mu.Lock()
	port := s.studioPort
	s.studioPort++
	s.mu.Unlock()
	s.mgr.Backend().SpawnDaemon(p.SandboxID, fmt.Sprintf("npx --no-install remotion studio --port %d --no-open", port), "", nil)
	p.StudioURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	s.step(p, "studio", fmt.Sprintf("Remotion Studio launched on port %d.", port))
	return p.StudioURL, port, nil
}

// --- file helpers (delegate to the jailed backend) ---
func (s *Store) ListFiles(pid, rel string) ([]types.FileEntry, error) {
	p, ok := s.Get(pid)
	if !ok {
		return nil, fmt.Errorf("project not found")
	}
	return s.mgr.Backend().List(p.SandboxID, rel)
}
func (s *Store) ReadFile(pid, rel string) (string, error) {
	p, _ := s.Get(pid)
	return s.mgr.Backend().ReadFile(p.SandboxID, rel)
}
func (s *Store) WriteFile(pid, rel, content string) error {
	p, _ := s.Get(pid)
	_, err := s.mgr.Backend().WriteFile(p.SandboxID, rel, content)
	return err
}
func (s *Store) RawPath(pid, rel string) (string, error) {
	p, _ := s.Get(pid)
	return s.mgr.Backend().RawPath(p.SandboxID, rel)
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

var tsxBlock = regexp.MustCompile("(?s)```(?:tsx|typescript|ts|jsx)?\\s*(.*?)```")

func extractJSON(text string) string {
	// Prefer a fenced block's interior, else the first '{'/'[' to the matching
	// last '}'/']' span. A brace span (not a non-greedy regex) is required so
	// nested objects like the storyboard's scene array survive intact.
	body := text
	if parts := strings.Split(text, "```"); len(parts) >= 3 {
		for i := 1; i < len(parts); i += 2 {
			chunk := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(parts[i]), "json"))
			if strings.HasPrefix(chunk, "{") || strings.HasPrefix(chunk, "[") {
				body = chunk
				break
			}
		}
	}
	st := strings.IndexAny(body, "{[")
	if st == -1 {
		return ""
	}
	open := body[st]
	close := byte('}')
	if open == '[' {
		close = ']'
	}
	en := strings.LastIndexByte(body, close)
	if en > st {
		return body[st : en+1]
	}
	return ""
}
func extractTSX(text string) string {
	if m := tsxBlock.FindStringSubmatch(text); m != nil {
		s := strings.TrimSpace(m[1])
		if strings.Contains(s, "export const") || strings.Contains(s, "import") {
			return s
		}
	}
	return strings.TrimSpace(text)
}

// Helpers consumed by director.go (same package).
func (p *Project) setState(st string)        { p.State = st; p.UpdatedAt = now() }
func (s *Store) logStep(p *Project, ph, d string) { s.step(p, ph, d) }
