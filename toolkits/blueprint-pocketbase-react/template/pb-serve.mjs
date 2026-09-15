#!/usr/bin/env node
/**
 * PocketBase launcher (SYSTEM-OWNED — hash-locked in the ownership canon).
 *
 * `manifest.pipeline.start` is `node pb-serve.mjs`; this is the entry point the
 * framework's `serve` spawns. It reads the port from the environment (`serve`
 * sets `PORT`), resolves the PocketBase binary and data directories next to this
 * file, and runs `pocketbase serve` as a child process — so stopping this
 * process stops PocketBase with it (`serve`/`stop` kill the whole tree).
 *
 * Why a launcher rather than the raw command in the manifest: `serve` spawns the
 * start command through the OS shell, and `pb/pocketbase serve --http
 * 127.0.0.1:${PORT} ...` is not portable across shells. A POSIX shell expands
 * `${PORT}` and runs an executable given with `/` separators; cmd.exe does
 * neither, so on Windows the raw form fails with "The system cannot find the path
 * specified." Launching the binary from Node with an explicit, platform-correct
 * path and an environment-sourced port removes both assumptions.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The port comes from the environment `serve` sets; the manifest's own `port` is
// the declared source when the launcher is run directly. No baked-in default.
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const port = process.env.PORT ?? manifest.port;
if (!port) {
  console.error("no port to bind: set PORT in the environment or `port` in manifest.json");
  process.exit(1);
}

// PocketBase ships as `pocketbase` on POSIX and `pocketbase.exe` on Windows; both
// live in `pb/` (see the pipeline `install` step). pb_public/ and pb_migrations/
// sit beside the binary and PocketBase resolves them relative to it.
const pbDir = join(here, "pb");
const binary = join(pbDir, process.platform === "win32" ? "pocketbase.exe" : "pocketbase");
if (!existsSync(binary)) {
  console.error(`PocketBase binary not found at ${binary} — download it into pb/ (pipeline \`install\`) before serving`);
  process.exit(1);
}

const child = spawn(
  binary,
  ["serve", "--http", `127.0.0.1:${port}`, "--dir", join(pbDir, "pb_data"), "--hooksDir", join(pbDir, "pb_hooks")],
  { stdio: "inherit" },
);

// Forward termination so a direct SIGINT/SIGTERM reaches PocketBase; `serve`/`stop`
// signal the whole process tree, but a launcher that is stopped on its own must
// not orphan the child.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

child.on("error", (err) => {
  console.error(`failed to launch PocketBase: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
