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
import { execFileSync, execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOST_VERSION = "0.1.0";

/** Cap on any single install/build command, so a hung build cannot block the
 *  host forever. */
const SHELL_TIMEOUT_MS = 600_000;

/** Terminate a child's whole process tree (it is spawned detached, so it leads
 *  its own group). Graceful SIGTERM/taskkill; the caller escalates if needed. */
function terminateChild(child: ChildProcess, force = false): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore" });
    } else {
      const sig = force ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(-pid, sig);
      } catch {
        child.kill(sig);
      }
    }
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      // Healthy means the health endpoint actually answers 2xx — a 404 (no
      // health route) or a 500 is NOT healthy, and a bare fetch with no abort
      // could hang past the whole budget on a black-hole port.
      if (res.ok) return true;
    } catch {
      /* not up yet, or this probe timed out */
    } finally {
      clearTimeout(timer);
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
    execSync(manifest.pipeline.install, { cwd: dir, stdio: "pipe", env, timeout: SHELL_TIMEOUT_MS });
  }
  if (manifest.pipeline.build) {
    log(`$ ${manifest.pipeline.build}`);
    execSync(manifest.pipeline.build, { cwd: dir, stdio: "pipe", env, timeout: SHELL_TIMEOUT_MS });
  }

  log(`$ ${manifest.pipeline.start}  (PORT=${port})`);
  // Detached so the whole process tree can be signalled on stop (the shell's
  // real server child would otherwise be orphaned by a bare child.kill()).
  const child = spawn(manifest.pipeline.start, {
    cwd: dir,
    env,
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => log(String(d).trimEnd()));
  child.stderr?.on("data", (d) => log(String(d).trimEnd()));

  const url = `http://127.0.0.1:${port}`;
  const healthUrl = `${url}${manifest.pipeline.health}`;
  const healthy = await pollHealth(healthUrl, opts.healthTimeoutMs ?? 30_000);
  if (!healthy) {
    terminateChild(child, true);
    throw new Error(`app "${manifest.name}" did not become healthy at ${healthUrl} in time`);
  }

  return {
    manifest,
    url,
    port,
    process: child,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminateChild(child, false);
      if (!(await waitForChildExit(child, 3000))) {
        terminateChild(child, true);
        await waitForChildExit(child, 2000);
      }
    },
  };
}

/**
 * Supervise a launched app: restart it if it exits unexpectedly (crash
 * watchdog). Returns a stop function that ends supervision.
 */
export interface SuperviseOptions extends LaunchOptions {
  /** Max consecutive crashes before the watchdog gives up. Default 5. */
  maxRestarts?: number;
  /** Base backoff between restarts, doubled each consecutive crash (capped at
   *  30s). Default 1000ms. A crash-on-boot app therefore backs off instead of
   *  hammering install/build/spawn in a tight loop. */
  restartBackoffMs?: number;
  /** How long the app must stay up before its crash counter resets. Default 30s. */
  healthyResetMs?: number;
  /** Called when the watchdog gives up after maxRestarts. */
  onGiveUp?: (crashes: number) => void;
}

export function supervise(dir: string, opts: SuperviseOptions = {}): { stop(): Promise<void> } {
  const maxRestarts = opts.maxRestarts ?? 5;
  const baseBackoff = opts.restartBackoffMs ?? 1000;
  const healthyResetMs = opts.healthyResetMs ?? 30_000;
  const log = opts.onLog ?? (() => {});
  let current: RunningApp | null = null;
  let stopped = false;
  let crashes = 0;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;

  async function boot(): Promise<void> {
    if (stopped) return;
    try {
      current = await launchApp(dir, opts);
    } catch (err) {
      // Launch itself failed (never became healthy). Count it as a crash and
      // back off rather than retrying instantly.
      onExit(err instanceof Error ? err.message : String(err));
      return;
    }
    const startedAt = Date.now();
    current.process.once("exit", () => {
      // A process that stayed up past the reset window is considered stable, so
      // an occasional later crash does not count toward the give-up limit.
      if (Date.now() - startedAt > healthyResetMs) crashes = 0;
      onExit("process exited");
    });
  }

  function onExit(reason: string): void {
    if (stopped) return;
    crashes += 1;
    if (crashes > maxRestarts) {
      log(`watchdog: giving up after ${crashes - 1} consecutive restarts (${reason})`);
      opts.onGiveUp?.(crashes - 1);
      stopped = true;
      return;
    }
    const delay = Math.min(baseBackoff * 2 ** (crashes - 1), 30_000);
    log(`watchdog: restart ${crashes}/${maxRestarts} in ${delay}ms (${reason})`);
    bootTimer = setTimeout(() => void boot(), delay);
  }

  void boot();

  return {
    async stop() {
      stopped = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (current) await current.stop();
    },
  };
}
