/**
 * agent-app <dir> open — show a RUNNING Agent App to the human.
 *
 * Opening a URL is an ENVIRONMENT capability, not a lifecycle step. Three
 * different actors can do it and only one of them is always present:
 *
 *   1. the agent's own browser tool  — only where the harness gave the model one
 *      (Claude Desktop's built-in browser, a Chrome extension). Unreachable from
 *      here: a tool call belongs to the agent, not to a child process. Such an
 *      agent passes `--print-only` and opens the URL itself.
 *   2. the harness plugin            — only where a plugin exists. It injects its
 *      behaviour through AGENT_APP_OPEN_CMD when it spawns this CLI, which needs
 *      no callback and works identically for the TypeScript and Python plugins.
 *   3. this CLI                      — ALWAYS available, because every harness can
 *      run a shell command. So the CLI owns the default and the others override.
 *
 * Whatever happens, the URL is printed. That is the real floor: every harness
 * renders a loopback URL as clickable text, so an app is never unreachable just
 * because no browser could be spawned.
 *
 * Failing to open is therefore NOT a failure exit — the app is running and the
 * URL is valid, which is the thing the caller asked about. Only an app that is
 * not actually answering is an error (exit 3, the unreachable contract).
 *
 * WHAT THIS COMMAND CANNOT DO: reload a tab the user already has open.
 *
 * It hands a URL to the operating system and the browser decides what that
 * means — a new tab for some, focus on an existing tab for others. Neither is a
 * reload, and no flag here can make it one: a loaded page can only be replaced
 * by code running inside it, which is not reachable from a child process. So
 * `open` deliberately does not pretend to. After a promote, the tab that was
 * already open is reached by the View's own update watcher
 * (`/_a2app/update.js`), which notices `appVersion` move and offers the person a
 * reload — offers, because these are data-entry apps and a reload nobody asked
 * for destroys whatever is half-typed. A NEW tab is a separate matter and is
 * already correct: static assets carry ETag/Last-Modified with
 * `Cache-Control: no-cache`, so it revalidates and gets the current code.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadProject, readAgentToken } from "../lib/project.js";
import { hasFlag } from "../lib/args.js";
import { countViewers, identifyApp } from "../lib/net.js";
import { log } from "../lib/log.js";

/** How the URL was surfaced. `none` still printed it. */
export type OpenVia = "harness-cmd" | "os-browser" | "print-only" | "none";

export interface OpenOutcome {
  opened: boolean;
  via: OpenVia;
  reason?: string;
}

/**
 * Is there plausibly a desktop to open a window onto?
 *
 * Spawning a browser in CI, over SSH, or on a headless box is worse than not
 * trying: it either fails noisily or opens a window on a machine nobody is
 * looking at. WSL is explicitly NOT headless — it has no DISPLAY but does have
 * a working opener into the Windows host.
 */
export function headlessReason(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return "CI is set";
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) return "running over SSH";
  if (platform === "linux" && !isWsl()) {
    const display = env.DISPLAY ?? env.WAYLAND_DISPLAY;
    if (display === undefined || display === "") return "no DISPLAY or WAYLAND_DISPLAY";
  }
  return null;
}

/** WSL exposes a Windows opener despite having no X display. */
function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if ((process.env.WSL_DISTRO_NAME ?? "") !== "") return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * The OS-level opener for this platform, as command + fixed args. The URL is
 * appended by the caller, never interpolated into a string — no shell is used
 * anywhere in this file.
 *
 * Windows `start` is a cmd builtin, hence `cmd /c start ""`; the empty string is
 * start's title argument, without which start treats the URL as the title.
 */
export function osOpener(platform = process.platform): { command: string; args: string[] }[] {
  if (platform === "win32") return [{ command: "cmd", args: ["/c", "start", ""] }];
  if (platform === "darwin") return [{ command: "open", args: [] }];
  if (isWsl()) return [{ command: "wslview", args: [] }, { command: "explorer.exe", args: [] }];
  return [{ command: "xdg-open", args: [] }];
}

/**
 * Split AGENT_APP_OPEN_CMD into argv. Whitespace-separated, so a harness can set
 * `code --open-url` or a bare `my-opener`. Deliberately not shell-parsed: this
 * value comes from the environment, and a shell here would make it an injection
 * surface for anything that can set an env var.
 */
export function parseOpenCmd(value: string): string[] {
  return value.trim().split(/\s+/).filter((t) => t !== "");
}

/** Spawn a detached opener. Resolves null on success, or the failure reason. */
function trySpawn(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch (err) {
      done(`${command}: ${(err as Error).message}`);
      return;
    }
    // A missing binary arrives asynchronously as 'error', never as a throw.
    child.on("error", (err) => done(`${command}: ${(err as Error).message}`));
    child.on("spawn", () => {
      child.unref();
      done(null);
    });
    // A spawn that neither errors nor reports within the budget is treated as
    // launched — the browser is detached and we must not hold the CLI open.
    const timer = setTimeout(() => {
      child.unref();
      done(null);
    }, 2000);
    timer.unref();
  });
}

/**
 * Walk the opener ladder for a URL. Exported so `serve --open` reuses the exact
 * same behaviour rather than reimplementing a second, drifting copy.
 */
export async function openUrl(url: string, printOnly: boolean): Promise<OpenOutcome> {
  if (printOnly) return { opened: false, via: "print-only" };

  const configured = process.env.AGENT_APP_OPEN_CMD;
  if (configured !== undefined && configured.trim() !== "") {
    const argv = parseOpenCmd(configured);
    const command = argv[0];
    if (command === undefined) {
      return { opened: false, via: "none", reason: "AGENT_APP_OPEN_CMD is empty" };
    }
    const failure = await trySpawn(command, [...argv.slice(1), url]);
    if (failure === null) return { opened: true, via: "harness-cmd" };
    // A harness that named an opener meant it: fall through to the OS browser
    // rather than silently substituting, but say what went wrong.
    log.warn(`AGENT_APP_OPEN_CMD failed (${failure}) — falling back to the OS browser`);
  }

  const headless = headlessReason();
  if (headless !== null) return { opened: false, via: "none", reason: headless };

  const failures: string[] = [];
  for (const { command, args } of osOpener()) {
    const failure = await trySpawn(command, [...args, url]);
    if (failure === null) return { opened: true, via: "os-browser" };
    failures.push(failure);
  }
  return { opened: false, via: "none", reason: `no usable opener (${failures.join("; ")})` };
}

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const port = project.manifest.port ?? 8090;
  const url = project.baseUrl;

  // Never open a URL that is not answering. A stale serve.json outlives a crashed
  // process, and a browser tab on a refused connection is worse than being told
  // the app is down — so the running app itself, not the record, is the source
  // of truth here.
  const servingId = await identifyApp(port);
  if (servingId === null) {
    log.error(`nothing is serving "${project.manifest.name}" on ${url}`);
    log.raw(
      JSON.stringify({ ok: false, url, error: "not serving", hint: `agent-app ${app} serve` }, null, 2),
    );
    return 3;
  }
  if (servingId !== project.manifest.id) {
    log.error(
      `port ${port} is held by a DIFFERENT Agent App (id ${servingId}) — refusing to open it as "${project.manifest.name}".`,
    );
    log.raw(JSON.stringify({ ok: false, url, error: "port held by another app", servingId }, null, 2));
    return 1;
  }

  // `--if-needed`: open only when nobody already has the app on screen.
  //
  // This is the "if open, refresh — if not, open" half that this command could
  // not previously express. The refresh half belongs to the page (its update
  // watcher reloads itself, or re-reads on a data change); this half is about
  // not stacking up duplicate tabs on the way. A browser given a URL it already
  // has open does NOT reliably focus that tab — Chrome opens another — so
  // "open every time" is not a harmless no-op.
  //
  // Only ever suppresses on a POSITIVE answer. An unknown count (older adapter,
  // no credential) opens, because a possibly-redundant tab is a smaller failure
  // than an update that reaches nobody.
  if (hasFlag(args, "if-needed")) {
    const viewers = await countViewers(port, readAgentToken(project.dir));
    if (viewers !== null && viewers > 0) {
      log.ok(`${viewers} open tab${viewers === 1 ? "" : "s"} on ${url} — leaving them to refresh themselves`);
      log.raw(
        JSON.stringify({ ok: true, id: project.manifest.id, name: project.manifest.name, url, opened: false, via: "already-open", viewers }, null, 2),
      );
      return 0;
    }
  }

  const outcome = await openUrl(url, hasFlag(args, "print-only"));

  // The URL is reported on every path, opened or not — it is the part that is
  // always useful, and the only part some harnesses can act on.
  if (outcome.opened) {
    log.ok(`opened ${url} (${outcome.via})`);
    // Whether this landed on a new tab or focused an old one is the browser's
    // call, and a focused old tab is still running old code. Say so rather than
    // let "opened" be read as "showing the current build".
    log.info("if this focused a tab you already had open, it will offer a reload rather than take one");
  } else if (outcome.via === "print-only") log.info(`open this in your browser: ${url}`);
  else log.warn(`could not open a browser (${outcome.reason ?? "unknown"}) — open this yourself: ${url}`);

  log.raw(
    JSON.stringify(
      {
        ok: true,
        id: project.manifest.id,
        name: project.manifest.name,
        url,
        opened: outcome.opened,
        via: outcome.via,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      },
      null,
      2,
    ),
  );
  return 0;
}
