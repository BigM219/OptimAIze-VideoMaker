// Filesystem jail: every relative path from an API client must resolve to a
// location strictly inside the sandbox workdir. Mirrors the Python resolve_in_jail:
// reject absolute paths, drive/UNC roots, and symlink/reparse escapes.

import fs from "node:fs";
import path from "node:path";
import { PathEscape } from "../types.js";

export function resolveInJail(workdir: string, relPath: string | null | undefined): string {
  if (relPath === null || relPath === undefined) {
    throw new PathEscape("Path is required.");
  }
  const raw = String(relPath);

  // Reject absolute paths (POSIX or Windows) and UNC.
  if (path.isAbsolute(raw)) {
    throw new PathEscape(`Absolute paths are not allowed: ${raw}`);
  }
  // Normalize separators and strip any leading slashes.
  const candidate = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  // A drive letter inside the first segment (e.g. "C:") is an absolute escape.
  const firstSeg = candidate.split("/")[0] ?? "";
  if (firstSeg.includes(":")) {
    throw new PathEscape(`Drive-absolute paths are not allowed: ${raw}`);
  }

  const root = path.resolve(workdir);
  const target = path.resolve(root, candidate);

  // Containment check on the lexical path.
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new PathEscape(`Path escapes the sandbox: ${raw}`);
  }

  // Symlink/reparse check: the real path must also stay inside the root.
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    // Target may not exist yet (writes); walk up to the nearest existing parent.
    let probe = path.dirname(target);
    while (probe && probe !== path.dirname(probe)) {
      if (fs.existsSync(probe)) {
        try {
          real = path.join(fs.realpathSync(probe), path.relative(probe, target));
        } catch {
          real = target;
        }
        break;
      }
      probe = path.dirname(probe);
    }
  }
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
  const realRel = path.relative(realRoot, real);
  if (realRel === ".." || realRel.startsWith(".." + path.sep) || path.isAbsolute(realRel)) {
    throw new PathEscape(`Path escapes the sandbox via a link: ${raw}`);
  }
  return target;
}
