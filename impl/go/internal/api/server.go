// HTTP API for OptimAIze-VideoMaker (Go, stdlib net/http). Port 8003,
// routes under /api/v1/vm. Mirrors the TS api.ts contract.
package api

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"optimaize-videomaker-go/internal/agent"
	"optimaize-videomaker-go/internal/projects"
	"optimaize-videomaker-go/internal/sandbox"
	"optimaize-videomaker-go/internal/skills"
)

const service = "OptimAIze VideoMaker API"
const version = "0.1.0"

type Server struct {
	store  *projects.Store
	mgr    *sandbox.Manager
	webDir string
}

func NewServer(mgr *sandbox.Manager, webDir string) *Server {
	return &Server{store: projects.NewStore(mgr), mgr: mgr, webDir: webDir}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func requireKey(r *http.Request) bool {
	expected := strings.TrimSpace(os.Getenv("OPTIMAIZE_API_KEY"))
	if expected == "" {
		return true
	}
	return r.Header.Get("X-API-Key") == expected
}

var (
	reItem    = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)$`)
	reFiles   = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/files$`)
	reContent = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/files/content$`)
	reRaw     = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/files/raw$`)
	reStudio  = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/studio$`)
	reGen     = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/generate$`)
	reChat    = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/chat$`)
	reExport  = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/export$`)
	reExpRaw  = regexp.MustCompile(`^/api/v1/vm/projects/([^/]+)/export/raw$`)
)

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": service, "version": version})
	})
	mux.HandleFunc("/api/v1/vm/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": service, "version": version, "platform": "win32"})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			if b, err := os.ReadFile(filepath.Join(s.webDir, "index.html")); err == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Write(b)
				return
			}
			w.Write([]byte("OptimAIze-VideoMaker (Go). Frontend not built."))
			return
		}
		// serve static assets
		p := filepath.Join(s.webDir, filepath.Clean(r.URL.Path))
		if strings.HasPrefix(p, s.webDir) {
			if b, err := os.ReadFile(p); err == nil {
				w.Header().Set("Content-Type", mimeOf(p))
				w.Write(b)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/api/v1/vm/", func(w http.ResponseWriter, r *http.Request) {
		if !requireKey(r) {
			writeJSON(w, 401, map[string]string{"detail": "Missing or invalid API key."})
			return
		}
		s.route(w, r)
	})
	return cors(mux)
}

func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api/v1/vm/runtime-config":
		writeJSON(w, 200, map[string]any{"policy": s.mgr.Policy()})
	case p == "/api/v1/vm/skills":
		writeJSON(w, 200, map[string]any{"skills": []any{skills.Info()}})
	case p == "/api/v1/vm/skills/rule":
		name := r.URL.Query().Get("name")
		if body, ok := skills.Rule(name); ok {
			writeJSON(w, 200, map[string]any{"name": name, "content": body})
		} else {
			writeJSON(w, 404, map[string]string{"detail": "rule not found"})
		}
	case p == "/api/v1/vm/models" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"models": agent.GetModels()})
	case p == "/api/v1/vm/models" && r.Method == "PUT":
		var b struct {
			Models []agent.ModelEntry `json:"models"`
		}
		if json.NewDecoder(r.Body).Decode(&b) != nil || b.Models == nil {
			writeJSON(w, 400, map[string]string{"detail": "models[] required"})
			return
		}
		writeJSON(w, 200, map[string]any{"models": agent.SetModels(b.Models)})
	case p == "/api/v1/vm/projects" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"projects": s.store.List()})
	case p == "/api/v1/vm/projects" && r.Method == "POST":
		var b struct{ Prompt, Requirements, Goals string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		writeJSON(w, 200, s.store.Create(b.Prompt, b.Requirements, b.Goals))
	case reGen.MatchString(p) && r.Method == "POST":
		id := reGen.FindStringSubmatch(p)[1]
		var b struct {
			Concept, Audience string
			DurationS         int `json:"duration_s"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b.DurationS == 0 {
			b.DurationS = 30
		}
		proj, ok := s.store.Get(id)
		if !ok {
			writeJSON(w, 404, map[string]string{"detail": "project not found"})
			return
		}
		concept := b.Concept
		if concept == "" {
			concept = proj.Prompt
		}
		go s.store.Generate(id, concept, b.Audience, b.DurationS)
		writeJSON(w, 200, proj)
	case reChat.MatchString(p) && r.Method == "POST":
		id := reChat.FindStringSubmatch(p)[1]
		var b struct {
			Message    string `json:"message"`
			ActiveFile string `json:"active_file"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		note, edited, err := s.store.ChatEditAgent(id, b.Message, b.ActiveFile)
		if err != nil {
			writeJSON(w, 500, map[string]string{"detail": err.Error()})
			return
		}
		proj, _ := s.store.Get(id)
		writeJSON(w, 200, map[string]any{"ok": true, "note": note, "edited": edited, "project": proj})
	case reStudio.MatchString(p) && r.Method == "POST":
		id := reStudio.FindStringSubmatch(p)[1]
		url, port, err := s.store.LaunchStudio(id)
		if err != nil {
			writeJSON(w, 404, map[string]string{"detail": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "url": url, "port": port})
	case reContent.MatchString(p) && r.Method == "GET":
		id := reContent.FindStringSubmatch(p)[1]
		path := r.URL.Query().Get("path")
		c, err := s.store.ReadFile(id, path)
		if err != nil {
			writeJSON(w, 404, map[string]string{"detail": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"path": path, "content": c})
	case reRaw.MatchString(p) && r.Method == "GET":
		id := reRaw.FindStringSubmatch(p)[1]
		abs, err := s.store.RawPath(id, r.URL.Query().Get("path"))
		if err != nil {
			writeJSON(w, 404, map[string]string{"detail": err.Error()})
			return
		}
		serveRange(w, r, abs)
	case reFiles.MatchString(p):
		id := reFiles.FindStringSubmatch(p)[1]
		if r.Method == "POST" {
			var b struct{ Path, Content string }
			_ = json.NewDecoder(r.Body).Decode(&b)
			if err := s.store.WriteFile(id, b.Path, b.Content); err != nil {
				writeJSON(w, 400, map[string]string{"detail": err.Error()})
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true, "path": b.Path})
		} else {
			rel := r.URL.Query().Get("path")
			if rel == "" {
				rel = "."
			}
			entries, err := s.store.ListFiles(id, rel)
			if err != nil {
				writeJSON(w, 404, map[string]string{"detail": err.Error()})
				return
			}
			writeJSON(w, 200, map[string]any{"entries": entries})
		}
	case reExport.MatchString(p) && r.Method == "POST":
		id := reExport.FindStringSubmatch(p)[1]
		proj, ok := s.store.Get(id)
		if !ok {
			writeJSON(w, 404, map[string]string{"detail": "project not found"})
			return
		}
		rr, _ := s.mgr.Backend().Exec(proj.SandboxID, "npx --no-install remotion render Video out/video.mp4", "", nil, 1200)
		if rr.ExitCode != 0 {
			writeJSON(w, 500, map[string]any{"ok": false, "detail": rr.Stderr})
			return
		}
		proj.ExportPath = "out/video.mp4"
		writeJSON(w, 200, map[string]any{"ok": true, "export_path": proj.ExportPath})
	case reExpRaw.MatchString(p) && r.Method == "GET":
		id := reExpRaw.FindStringSubmatch(p)[1]
		proj, ok := s.store.Get(id)
		if !ok || proj.ExportPath == "" {
			writeJSON(w, 404, map[string]string{"detail": "not exported yet"})
			return
		}
		abs, err := s.store.RawPath(id, proj.ExportPath)
		if err != nil {
			writeJSON(w, 404, map[string]string{"detail": err.Error()})
			return
		}
		serveRange(w, r, abs)
	case reItem.MatchString(p) && r.Method == "GET":
		id := reItem.FindStringSubmatch(p)[1]
		if proj, ok := s.store.Get(id); ok {
			writeJSON(w, 200, proj)
		} else {
			writeJSON(w, 404, map[string]string{"detail": "project not found"})
		}
	default:
		http.NotFound(w, r)
	}
}

func serveRange(w http.ResponseWriter, r *http.Request, abs string) {
	f, err := os.Open(abs)
	if err != nil {
		writeJSON(w, 404, map[string]string{"detail": "not found"})
		return
	}
	defer f.Close()
	info, _ := f.Stat()
	total := info.Size()
	ct := mimeOf(abs)
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	if rg := r.Header.Get("Range"); strings.HasPrefix(rg, "bytes=") {
		spec := strings.TrimPrefix(rg, "bytes=")
		dash := strings.IndexByte(spec, '-')
		if dash >= 0 {
			start, _ := strconv.ParseInt(spec[:dash], 10, 64)
			end := total - 1
			if spec[dash+1:] != "" {
				if e, err := strconv.ParseInt(spec[dash+1:], 10, 64); err == nil {
					end = e
				}
			}
			if end >= total {
				end = total - 1
			}
			w.Header().Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(total, 10))
			w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
			w.WriteHeader(http.StatusPartialContent)
			f.Seek(start, io.SeekStart)
			io.CopyN(w, f, end-start+1)
			return
		}
	}
	w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
	w.WriteHeader(200)
	io.Copy(w, f)
}

func mimeOf(p string) string {
	if t := mime.TypeByExtension(filepath.Ext(p)); t != "" {
		return t
	}
	return "application/octet-stream"
}

func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}
