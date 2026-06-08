// Tiny .env reader for tools that need provider keys (Go parity of env.ts).
// Mirrors the agent package's loadDotenv path logic so websearch reads the same
// impl/go/.env. process env wins over .env file.
package tool

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	dotenvOnce sync.Once
	dotenvVals map[string]string
)

func loadToolDotenv() map[string]string {
	out := map[string]string{}
	exe, _ := os.Executable()
	candidates := []string{
		filepath.Join(filepath.Dir(exe), ".env"),
		".env",
	}
	for _, p := range candidates {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if eq := strings.IndexByte(line, '='); eq != -1 {
				out[strings.TrimSpace(line[:eq])] = strings.TrimSpace(line[eq+1:])
			}
		}
		f.Close()
		break
	}
	return out
}

// readEnv returns os.Getenv(name) if set, else the .env value, else "".
func readEnv(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	dotenvOnce.Do(func() { dotenvVals = loadToolDotenv() })
	return dotenvVals[name]
}
