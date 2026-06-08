// bash — run a terminal command inside the caged sandbox (Go parity of bash.ts).
package tool

import "fmt"

const defaultTimeoutMS = 120_000 // 2 minutes

// BashTool wraps backend.Exec (already caged by a Job Object + jailed workdir).
var BashTool = Def{
	ID: "bash",
	Description: "Run a terminal command inside the project sandbox (git, npm, npx, remotion, ls, etc.). " +
		"The sandbox is resource-capped and jailed to the project workdir. Prefer the read/write/edit/grep/glob tools for file work; " +
		"use bash for builds, installs, and running commands. Default timeout 120s.",
	Parameters: []Param{
		{Name: "command", Type: "string", Description: "The command to execute", Required: true},
		{Name: "description", Type: "string", Description: "Clear, concise description of what this command does (5-10 words)", Required: true},
		{Name: "timeout", Type: "number", Description: "Optional timeout in milliseconds (default 120000)"},
	},
	Validate: func(args map[string]any) (map[string]any, error) {
		command, err := reqString(args, "command")
		if err != nil {
			return nil, err
		}
		description, err := reqString(args, "description")
		if err != nil {
			return nil, err
		}
		timeout, _, err := optNumber(args, "timeout")
		if err != nil {
			return nil, err
		}
		return map[string]any{"command": command, "description": description, "timeout": timeout}, nil
	},
	Execute: func(args map[string]any, ctx *Context) (Result, error) {
		command := args["command"].(string)
		description := args["description"].(string)
		timeoutMS := defaultTimeoutMS
		if t, ok := args["timeout"].(float64); ok && t > 0 {
			timeoutMS = int(t)
		}
		ctx.LogStep("command", description, StepExtra{Kind: "command", Command: command})

		r, err := ctx.Backend.Exec(ctx.SandboxID, command, "", nil, float64(timeoutMS)/1000.0)
		if err != nil {
			return Result{Title: description, Output: "Command failed to start: " + err.Error(), Metadata: map[string]any{"error": "exec_failed"}}, nil
		}
		combined := r.Stdout
		if r.Stderr != "" {
			if combined != "" {
				combined += "\n"
			}
			combined += r.Stderr
		}
		body := combined
		if body == "" {
			body = "(no output)"
		}
		if r.TimedOut {
			body += fmt.Sprintf("\n\n<shell_metadata>\nCommand terminated after exceeding the %d ms timeout. "+
				"If it needs longer and is not waiting for interactive input, retry with a larger timeout.\n</shell_metadata>", timeoutMS)
		} else if r.KilledByCap {
			body += "\n\n<shell_metadata>\nProcess killed by the sandbox resource cap (RAM/CPU). Reduce memory use or split the work.\n</shell_metadata>"
		}
		out, truncated, outputPath := truncateOutput(ctx, "bash", body, 30*1024)
		exit := r.ExitCode
		ctx.LogStep("command", fmt.Sprintf("exit %d", exit), StepExtra{Kind: "command_output", ExitCode: &exit, Output: combined})
		return Result{
			Title:      description,
			Output:     out,
			Truncated:  truncated,
			OutputPath: outputPath,
			// A nonzero exit is NOT a soft failure (the model often expects it);
			// the model reads the exit line in the output.
			Metadata: map[string]any{"exit": r.ExitCode, "timedOut": r.TimedOut, "killedByCap": r.KilledByCap},
		}, nil
	},
}
