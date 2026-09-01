/**
 * @a2app/host — the optional reference host.
 *
 * A host launches, displays, and supervises Agent Apps for a user. It is
 * OPTIONAL by design: a bare agent with a browser is a complete environment.
 * A host launches ANY stack knowing only the manifest `pipeline` block — it runs
 * the declared `install`/`build`/`start` commands and polls the declared
 * `health` path, never reading a backend-specific config. It adds conveniences
 * (supervision, display) but no compliance requirement.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOST_VERSION = "0.1.0";

export * from "./receipts.js";

export interface HostManifest {
  id: string;
  name: string;
  authMode: "none" | "multi-user";
  pipeline: { install: string; build: string; start: string; health: string };
  port?: number;
}

export interface LaunchOptions {
  /** override the port; otherwise manifest.port or a free port is used. */
  port?: number;
  /** run `pipeline.install` before build (once per environment). Default true. */
  install?: boolean;
  /** ms to wait for the health endpoint before giving up. Default 30s. */
  healthTimeoutMs?: number;
  /** sink for child stdout/stderr lines (build view). */
  onLog?: (line: string) => void;
}

export interface RunningApp {
  manifest: HostManifest;
  url: string;
  port: number;
  process: ChildProcess;
  stop(): Promise<void>;
}

export function readManifest(dir: string): HostManifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as HostManifest;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Launch an Agent App: install (optional) → build → start → poll health.
 * Resolves once the health endpoint answers, or rejects on timeout.
 */
export async function launchApp(dir: string, opts: LaunchOptions = {}): Promise<RunningApp> {
  const manifest = readManifest(dir);
  const port = opts.port ?? manifest.port ?? (await freePort());
  const log = opts.onLog ?? (() => {});
  const env = { ...process.env, PORT: String(port) };

  if (opts.install !== false && manifest.pipeline.install) {
    log(`$ ${manifest.pipeline.install}`);
    execSync(manifest.pipeline.install, { cwd: dir, stdio: "pipe", env });
  }
  if (manifest.pipeline.build) {
    log(`$ ${manifest.pipeline.build}`);
    execSync(manifest.pipeline.build, { cwd: dir, stdio: "pipe", env });
  }

  log(`$ ${manifest.pipeline.start}  (PORT=${port})`);
  const child = spawn(manifest.pipeline.start, { cwd: dir, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d) => log(String(d).trimEnd()));
  child.stderr?.on("data", (d) => log(String(d).trimEnd()));

  const url = `http://127.0.0.1:${port}`;
  const healthUrl = `${url}${manifest.pipeline.health}`;
  const healthy = await pollHealth(healthUrl, opts.healthTimeoutMs ?? 30_000);
  if (!healthy) {
    child.kill();
    throw new Error(`app "${manifest.name}" did not become healthy at ${healthUrl} in time`);
  }

  return {
    manifest,
    url,
    port,
    process: child,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

/**
 * Supervise a launched app: restart it if it exits unexpectedly (crash
 * watchdog). Returns a stop function that ends supervision.
 */
export function supervise(dir: string, opts: LaunchOptions = {}): { stop(): Promise<void> } {
  let current: RunningApp | null = null;
  let stopped = false;

  async function boot(): Promise<void> {
    if (stopped) return;
    current = await launchApp(dir, opts);
    current.process.once("exit", () => {
      if (!stopped) void boot();
    });
  }
  void boot();

  return {
    async stop() {
      stopped = true;
      if (current) await current.stop();
    },
  };
}
