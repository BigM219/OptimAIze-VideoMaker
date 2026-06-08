// OptimAIze-VideoMaker (TS) entry point. Serves API + built frontend on :8003.

import { serve } from "@hono/node-server";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getManager } from "./sandbox/manager.js";
import { buildApp } from "./api.js";

const PORT = Number(process.env.OPTIMAIZE_VIDEOMAKER_PORT ?? 8003);

// Built frontend lives at ../../frontend/dist relative to dist/server.js, or
// the source frontend/dist when run via strip-types.
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  // dist/server.js -> module root /frontend/dist
  path.resolve(here, "..", "..", "..", "frontend", "dist"),
  // src/server.ts (strip-types) -> module root /frontend/dist
  path.resolve(here, "..", "..", "frontend", "dist"),
];
const webDir = candidates.find((d) => fs.existsSync(path.join(d, "index.html"))) ?? candidates[0];

const app = buildApp(webDir);
const server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`OptimAIze-VideoMaker (TS) listening on http://127.0.0.1:${info.port}`);
  console.log(`Serving frontend from ${webDir}`);
});

function shutdown(): void {
  console.log("Shutting down; destroying live sandboxes.");
  try {
    getManager().destroyAll();
  } catch {
    /* ignore */
  }
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
