import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build into the backend-served dist; dev proxies the API to :8003.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5183,
    proxy: { "/api": "http://127.0.0.1:8003" },
  },
});
