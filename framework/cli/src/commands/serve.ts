/**
 * a2app serve <dir> [--install]
 *
 * Launch a running Agent App the framework way — never "start a server by hand".
 * Runs the manifest `pipeline` (optionally `install`, then `build`, then `start`)
 * as a MANAGED BACKGROUND process bound to `manifest.port` (the same port the
 * operate commands read), polls `pipeline.health` until the app answers, and
 * records `.a2app/serve.json` so `a2app stop` can shut it down. Server stdout is
 * captured to `.a2app/serve.log` for diagnosis.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject, UsageError } from "../lib/project.js";
import { runShell } from "../lib/shell.js";
import { log } from "../lib/log.js";

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app serve <dir> [--install]");
  const project = loadProject(dir);
  const pipeline = project.manifest.pipeline;
  const port = project.manifest.port ?? 8090;
  const healthUrl = `${project.baseUrl}${pipeline?.health ?? "/api/_a2app"}`;
  if (!pipeline?.start) {
    log.error("manifest.pipeline.start is empty — nothing to launch");
    return 1;
  }

  const servePath = join(project.dir, ".a2app", "serve.json");
  if (existsSync(servePath) && (await pollHealth(healthUrl, 500))) {
    const prev = JSON.parse(readFileSync(servePath, "utf8")) as { pid: number };
    log.ok(`already serving on ${project.baseUrl} (pid ${prev.pid})`);
    log.raw(JSON.stringify({ ok: true, url: project.baseUrl, pid: prev.pid, alreadyRunning: true }, null, 2));
    return 0;
  }

  if (args.includes("--install") && pipeline.install) {
    log.step(`install: ${pipeline.install}`);
    runShell(pipeline.install, project.dir);
  }
  if (pipeline.build) {
    log.step(`build: ${pipeline.build}`);
    runShell(pipeline.build, project.dir);
  }

  mkdirSync(join(project.dir, ".a2app"), { recursive: true });
  const outFd = openSync(join(project.dir, ".a2app", "serve.log"), "a");
  const child = spawn(pipeline.start, {
    cwd: project.dir,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ["ignore", outFd, outFd],
    shell: true,
  });
  child.unref();
  const pid = child.pid ?? -1;

  log.step(`launching: ${pipeline.start} (port ${port})`);
  if (!(await pollHealth(healthUrl, 20_000))) {
    log.error(`app did not become healthy at ${healthUrl} within 20s — see ${join(dir, ".a2app", "serve.log")}`);
    return 1;
  }

  writeFileSync(servePath, JSON.stringify({ pid, port, url: project.baseUrl, startedAt: new Date().toISOString() }, null, 2) + "\n");
  log.ok(`serving "${project.manifest.name}" on ${project.baseUrl} (pid ${pid})`);
  log.raw(JSON.stringify({ ok: true, url: project.baseUrl, pid, port }, null, 2));
  return 0;
}
