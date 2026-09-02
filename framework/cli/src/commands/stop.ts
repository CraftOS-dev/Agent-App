/**
 * agent-app stop <dir> — stop an app launched with `agent-app serve`, killing the whole
 * process tree and clearing `.a2app/serve.json`.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProject, UsageError } from "../lib/project.js";
import { register } from "../lib/registry.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: agent-app stop <dir>");
  const project = loadProject(dir);
  const servePath = join(project.dir, ".a2app", "serve.json");
  if (!existsSync(servePath)) {
    log.info("not serving (no .a2app/serve.json)");
    log.raw(JSON.stringify({ ok: true, stopped: null }, null, 2));
    return 0;
  }
  const { pid } = JSON.parse(readFileSync(servePath, "utf8")) as { pid: number };
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(servePath, { force: true });
  // Keep the index current on the way down too: an app whose path or port moved
  // since it was registered is corrected here rather than drifting.
  try {
    await register({
      id: project.manifest.id,
      name: project.manifest.name,
      path: project.dir,
      ...(project.manifest.port !== undefined ? { port: project.manifest.port } : {}),
    });
  } catch {
    /* an unwritable index never fails a stop */
  }
  log.ok(`stopped (pid ${pid})`);
  log.raw(JSON.stringify({ ok: true, stopped: pid }, null, 2));
  return 0;
}
