// OptimAIze-VideoMaker (Go) entry point. Serves the API + built frontend on :8003.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"optimaize-videomaker-go/internal/api"
	"optimaize-videomaker-go/internal/sandbox"
)

func main() {
	port := os.Getenv("OPTIMAIZE_VIDEOMAKER_PORT")
	if port == "" {
		port = "8003"
	}

	// Frontend dist: module-root/frontend/dist (next to impl/go), or ./frontend/dist.
	webDir := filepath.Join("..", "..", "frontend", "dist")
	if exe, err := os.Executable(); err == nil {
		cand := filepath.Join(filepath.Dir(exe), "..", "..", "frontend", "dist")
		if _, err := os.Stat(filepath.Join(cand, "index.html")); err == nil {
			webDir = cand
		}
	}

	mgr := sandbox.NewManager()
	srv := api.NewServer(mgr, webDir)
	httpServer := &http.Server{Addr: "127.0.0.1:" + port, Handler: srv.Handler()}

	go func() {
		log.Printf("OptimAIze-VideoMaker (Go) listening on http://127.0.0.1:%s", port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Println("Shutting down; destroying live sandboxes.")
	mgr.DestroyAll()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(ctx)
}
