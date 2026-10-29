/**
 * The adopted app as a child process of the sidecar: started from a declared
 * argv, waited for until it answers its health path, and stopped when the
 * sidecar stops.
 *
 * The argv is run directly, never through a shell, so nothing in `sidecar.json`
 * is ever interpreted as shell syntax. The app shares the sidecar's process
 * group, so the framework stopping the sidecar's tree (`agent-app stop`, or
 * `serve` killing a launch that never became healthy) reaches the app too; the
 * sidecar also stops it itself whenever it stops on its own.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/** How long a stopping app is given to exit on its own before it is killed. */
const STOP_GRACE_MS = 5_000;
/** One health probe's deadline: a port that accepts and never answers must not
 *  stall the wait past its own budget. */
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 150;

export interface LaunchSpec {
  /** argv, already expanded */
  command: string[];
  /** absolute working directory */
  cwd: string;
  /** the app's complete environment */
  env: NodeJS.ProcessEnv;
  /** `http://127.0.0.1:<port>` — where the app answers */
  url: string;
  health: string;
  startTimeoutMs: number;
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Upstream {
  readonly pid: number;
  readonly url: string;
  /** settles when the app's process ends, for whatever reason */
  readonly exited: Promise<ExitStatus>;
  /** end the app: politely, then by force */
  stop(): Promise<void>;
  /** end the app at once and synchronously — for a process that is exiting */
  killNow(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describeExit({ code, signal }: ExitStatus): string {
  return signal !== null ? `was killed by ${signal}` : `exited with code ${code}`;
}

/** Why the argv could not be started, in terms of what to change. */
function spawnFailure(program: string, e: NodeJS.ErrnoException): Error {
  if (e.code === "ENOENT" || e.code === "EINVAL") {
    return new Error(
      `could not start the app: "${program}" is not an executable on PATH (${e.code}). ` +
        `upstream.command runs without a shell, so name the program itself — on Windows a .cmd/.bat ` +
        `script (npm, npx, yarn) cannot be started this way: run its target with node instead.`,
    );
  }
  return new Error(`could not start the app: ${e.message}`);
}

/** Does the app answer its health path yet? Any status below 400 counts. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return res.status < 400;
  } catch {
    return false;
  }
}

/** End a process tree now. Windows has no signal a console app without a
 *  window can be asked to stop with, so it is ended by force, tree and all. */
function forceKill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

/**
 * Start the app and wait until it answers. Rejects — with the app stopped —
 * when it cannot be started, exits first, or does not answer in time.
 */
export async function launchUpstream(spec: LaunchSpec): Promise<Upstream> {
  const [program, ...args] = spec.command;
  if (program === undefined) throw new Error("could not start the app: upstream.command is empty");

  const child = spawn(program, args, {
    cwd: spec.cwd,
    env: spec.env,
    // The app's own output goes where the sidecar's does: the log `serve` keeps.
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });

  // Written by the child's listeners, read by the wait below and by stop().
  const state: { ended: ExitStatus | null; failed: Error | null } = { ended: null, failed: null };
  const exited = new Promise<ExitStatus>((done) => {
    child.once("exit", (code, signal) => {
      state.ended = { code, signal };
      done(state.ended);
    });
    // A spawn failure emits 'error' and may never emit 'exit'.
    child.once("error", (e) => {
      state.failed = spawnFailure(program, e as NodeJS.ErrnoException);
      state.ended ??= { code: null, signal: null };
      done(state.ended);
    });
  });

  async function stop(): Promise<void> {
    if (state.ended !== null) return;
    if (process.platform === "win32") {
      forceKill(child);
    } else {
      child.kill("SIGTERM");
      if (await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)])) return;
      forceKill(child);
    }
    await exited;
  }

  const healthUrl = spec.url + spec.health;
  const deadline = Date.now() + spec.startTimeoutMs;
  for (;;) {
    if (state.failed !== null) throw state.failed;
    if (state.ended !== null) throw new Error(`the app ${describeExit(state.ended)} before answering ${healthUrl}`);
    if (await answers(healthUrl)) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`the app did not answer ${healthUrl} within ${spec.startTimeoutMs} ms`);
    }
    await sleep(PROBE_INTERVAL_MS);
  }

  return {
    pid: child.pid!,
    url: spec.url,
    exited,
    stop,
    killNow: () => {
      if (state.ended === null) forceKill(child);
    },
  };
}
