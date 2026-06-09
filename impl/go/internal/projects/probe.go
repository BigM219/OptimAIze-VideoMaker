// Per-frame render probe (Go parity of impl/ts/src/probe.ts).
// Remotion render errors are frame-dependent: interpolating a color string throws
// "... is not a supported scale, translate, or rotate value" only at frames where
// the interpolated value crosses a threshold, so rendering frame 0 alone can pass
// while frame 60 fails. probeScene samples a handful of representative frames via
// `remotion still` (one PNG per frame, no encoder), fails fast on the first frame
// that errors, and reports WHICH frame + the stderr so the agent fixes it.
package projects

import (
	"fmt"
	"sort"
)

// ProbeResult mirrors the TS ProbeResult shape.
type ProbeResult struct {
	OK          bool   `json:"ok"`
	FramesTested []int `json:"framesTested"`
	FailedFrame *int   `json:"failedFrame,omitempty"`
	Error       string `json:"error,omitempty"`
	LastPNG     string `json:"lastPng,omitempty"`
}

// sampleFrames picks a small, representative set of frames (start, quarter points,
// last), deduped + sorted ascending, capped at 5 stills/scene.
func sampleFrames(durationInFrames int) []int {
	last := durationInFrames - 1
	if last < 0 {
		last = 0
	}
	if last == 0 {
		return []int{0}
	}
	raw := []int{0, int(float64(last) * 0.25), int(float64(last) * 0.5), int(float64(last) * 0.75), last}
	seen := map[int]bool{}
	var out []int
	for _, f := range raw {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	sort.Ints(out)
	return out
}

// probeScene renders sampled frames as stills, failing fast on the first error.
// Emits a transcript step per probe so the UI shows the command + outcome (frame).
func (s *Store) probeScene(pid string, scene Scene) ProbeResult {
	p, ok := s.Get(pid)
	if !ok || p.SandboxID == "" {
		return ProbeResult{OK: false, Error: "no sandbox"}
	}
	backend := s.mgr.Backend()
	frames := sampleFrames(scene.DurationInFrames)
	var tested []int
	lastPNG := ""
	for _, frame := range frames {
		fr := frame
		s.stepRich(p, Step{Phase: "probe", Kind: "command", Frame: &fr,
			Detail:  fmt.Sprintf("Probe %s @ frame %d", scene.ID, frame),
			Command: fmt.Sprintf("remotion still %s --frame=%d", scene.ID, frame)})
		out := fmt.Sprintf("out/.probe/%s-%d.png", scene.ID, frame)
		// `still` renders a single frame to PNG with no video encoder — faster than
		// `render --frames=N-N`. --scale=0.5 halves the work; an error still throws.
		cmd := fmt.Sprintf("npx --no-install remotion still %s %s --frame=%d --image-format=png --scale=0.5", scene.ID, out, frame)
		r, err := backend.Exec(p.SandboxID, cmd, "", nil, 120)
		if err != nil {
			ec := -1
			s.stepRich(p, Step{Phase: "probe", Kind: "command_output", Frame: &fr, ExitCode: &ec,
				Detail: fmt.Sprintf("Probe %s @ frame %d could not run", scene.ID, frame), Output: err.Error()})
			return ProbeResult{OK: false, FramesTested: tested, FailedFrame: &fr, Error: capField(err.Error())}
		}
		tested = append(tested, frame)
		if r.ExitCode != 0 {
			combined := r.Stdout + "\n" + r.Stderr
			ec := r.ExitCode
			s.stepRich(p, Step{Phase: "probe", Kind: "command_output", Frame: &fr, ExitCode: &ec,
				Detail: fmt.Sprintf("Probe %s failed at frame %d (exit %d)", scene.ID, frame, r.ExitCode), Output: combined})
			return ProbeResult{OK: false, FramesTested: tested, FailedFrame: &fr, Error: capField(combined)}
		}
		lastPNG = out
	}
	ec := 0
	s.stepRich(p, Step{Phase: "probe", Kind: "command_output", ExitCode: &ec,
		Detail: fmt.Sprintf("Probe %s OK (%d frames)", scene.ID, len(tested)),
		Output: fmt.Sprintf("Frames %v all rendered.", tested)})
	return ProbeResult{OK: true, FramesTested: tested, LastPNG: lastPNG}
}

// frameErr formats a probe failure as "frame N: <stderr>" for the repair seed.
func frameErr(r ProbeResult) string {
	ff := -1
	if r.FailedFrame != nil {
		ff = *r.FailedFrame
	}
	return fmt.Sprintf("frame %d: %s", ff, r.Error)
}

// ProbeSceneManual runs a probe on demand (the UI "Probe lại" button), updating
// the scene's status/renderError in place. Returns nil if the scene isn't found.
func (s *Store) ProbeSceneManual(pid, sceneID string) *ProbeResult {
	p, ok := s.Get(pid)
	if !ok || p.Storyboard == nil {
		return nil
	}
	var sc *Scene
	for i := range p.Storyboard.Scenes {
		if p.Storyboard.Scenes[i].ID == sceneID {
			sc = &p.Storyboard.Scenes[i]
			break
		}
	}
	if sc == nil {
		return nil
	}
	res := s.probeScene(pid, *sc)
	if res.OK {
		sc.Status = "ready"
		sc.RenderError = ""
	} else {
		sc.Status = "error"
		sc.RenderError = frameErr(res)
	}
	p.UpdatedAt = now()
	return &res
}
