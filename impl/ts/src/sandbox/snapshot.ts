// Snapshot/restore: zip the sandbox workdir, including deep node_modules, using
// Windows extended-length paths so files past MAX_PATH are captured and restored.
// Mirrors the Python snapshot_workdir / restore_into, including the zip-slip guard.

import fs from "node:fs";
import path from "node:path";
import yazl from "yazl";
import yauzl from "yauzl";
import { SandboxOperationError } from "../types.js";

const IS_WINDOWS = process.platform === "win32";

function longPath(p: string): string {
  if (!IS_WINDOWS) return p;
  const abs = path.resolve(p);
  if (abs.startsWith("\\\\?\\")) return abs;
  if (abs.startsWith("\\\\")) return "\\\\?\\UNC\\" + abs.slice(2);
  return "\\\\?\\" + abs;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(longPath(dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) out.push(abs);
    }
  }
  return out;
}

export async function snapshotWorkdir(workdir: string, destZip: string): Promise<string> {
  const root = path.resolve(workdir);
  fs.mkdirSync(path.dirname(destZip), { recursive: true });

  const files = walkFiles(root);
  const zip = new yazl.ZipFile();
  const done = new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destZip);
    zip.outputStream.pipe(out).on("close", resolve).on("error", reject);
  });

  let count = 0;
  let skipped = 0;
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    try {
      const buf = fs.readFileSync(longPath(abs)); // buffer avoids stream EMFILE storms
      zip.addBuffer(buf, rel, { compress: true });
      count += 1;
    } catch {
      // Transient (npm churns temp files) or locked; skip like the Python path.
      skipped += 1;
    }
  }
  zip.end();
  await done;
  return destZip;
}

export async function restoreInto(workdir: string, srcZip: string): Promise<void> {
  const root = path.resolve(workdir);
  if (!fs.existsSync(srcZip)) throw new SandboxOperationError(`Snapshot archive not found: ${srcZip}`);

  await new Promise<void>((resolve, reject) => {
    yauzl.open(srcZip, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("open failed"));
      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const member = entry.fileName;
        if (member.endsWith("/")) {
          zipfile.readEntry();
          return;
        }
        // zip-slip guard: resolved target must stay under root.
        const target = path.resolve(root, member);
        const rel = path.relative(root, target);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          return reject(new SandboxOperationError(`Unsafe path in snapshot: ${member}`));
        }
        zipfile.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error("read stream failed"));
          fs.mkdirSync(path.dirname(longPath(target)), { recursive: true });
          const ws = fs.createWriteStream(longPath(target));
          rs.pipe(ws);
          ws.on("close", () => zipfile.readEntry());
          ws.on("error", reject);
        });
      });
      zipfile.on("end", resolve);
      zipfile.on("error", reject);
    });
  });
}
