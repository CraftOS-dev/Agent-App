/**
 * How the framework reaches an agent harness — and which of those routes this
 * machine actually has.
 *
 * A2App already carries the app→agent plane: an app emits an event, a task
 * lands in its queue, and `a2app <app> tasks` claims it. What that plane does
 * NOT do is make anything happen. A submitted task sits in `submitted` until
 * some agent happens to look, so an app can ask for work and never be heard.
 * Delivery is the missing half, and it is the only half that depends on the
 * harness rather than on the protocol.
 *
 * Harnesses differ in exactly one way that matters here: what can be used to
 * TRIGGER them. That produces a ladder, deepest integration first:
 *
 *   1 inbound    the harness exposes an HTTP endpoint that starts a run. The
 *                deepest route, and the rarest — few harnesses offer one.
 *   2 headless   the harness has a one-shot headless CLI (`claude -p`,
 *                `codex exec`, `gemini -p`, `aider --message`). Universal: any
 *                harness with a headless mode qualifies. This is the DEFAULT —
 *                not a fallback — because it is what the built-in profiles
 *                below already describe, so most machines land here with
 *                nothing configured.
 *   3 gateway    the harness is triggered through a local gateway process that
 *                is not running yet; the framework starts it and then posts to
 *                it, so the operator does not have to set it up by hand.
 *   4 subscribe  the harness cannot be triggered at all, but it can run a
 *                background loop of its own. The framework's contribution is
 *                then a listen command (`a2app <app> tasks next --wait`) rather
 *                than a delivery.
 *   5 none       none of the above is available here. Bi-directional operation
 *                is NOT supported, and the honest answer is to say so and name
 *                what would change it — never to half-deliver.
 *
 * A profile lists whichever routes its harness offers, in any order; the ladder
 * decides which one is used, so adding a deeper route to a profile upgrades it
 * without any other change. Rung 5 is not a route — it is what is reported when
 * the ladder runs out, and it is why {@link chooseRoute} may return null.
 *
 * Profiles are machine state, not app state: which harnesses are installed is a
 * property of this computer, so they live in the framework home and are shared
 * by every app on it.
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homePath } from "./home.js";
import { readJsonFile } from "./json.js";
import { fetchWithTimeout } from "./net.js";
import { EnvError } from "./project.js";

export const HARNESSES_FILE = "harnesses.json";
export const HARNESSES_VERSION = 1;

/** Where a headless route's rendered prompt goes in its argument list. */
export const PROMPT_PLACEHOLDER = "{prompt}";

/** The rungs, in ladder order. `none` is the absence of a route, so it is not
 *  one of these — it is what {@link chooseRoute} returning null means. */
export type DeliveryMode = "inbound" | "headless" | "gateway" | "subscribe";

/** Ladder order: the first available mode wins. Deepest integration first. */
export const LADDER: readonly DeliveryMode[] = ["inbound", "headless", "gateway", "subscribe"];

/** Rung 1 — POST the task to an endpoint the harness already serves. */
export interface InboundRoute {
  mode: "inbound";
  url: string;
  /** default POST */
  method?: string;
  headers?: Record<string, string>;
  /**
   * Name of an environment variable holding a bearer token for the harness's
   * own endpoint. The NAME is stored, never the value: a config file that
   * carried the secret itself would be a credential at rest in a file the user
   * is invited to hand-edit and paste around.
   */
  tokenEnv?: string;
  /** GET here to decide whether the endpoint is up. Absent means "assume it is". */
  health?: string;
}

/** Rung 2 — run the harness's one-shot headless CLI. */
export interface HeadlessRoute {
  mode: "headless";
  /** the binary, resolved on PATH (or an absolute path) */
  command: string;
  /** its arguments; exactly one carries {@link PROMPT_PLACEHOLDER}, unless
   *  `input` is "stdin" */
  args: string[];
  /** where the prompt goes: substituted into `args` (default) or written to stdin */
  input?: "arg" | "stdin";
  /** working directory: "app" (default) for the app's own directory, or a path */
  cwd?: string;
  /** how long one run may take before it is killed (default 15 min) */
  timeoutMs?: number;
}

/** Rung 3 — a local gateway the framework brings up, then posts to. */
export interface GatewayRoute {
  mode: "gateway";
  url: string;
  /** the shell command that starts the gateway, run only when `health` fails */
  start: string;
  /** REQUIRED: without it there is no way to know whether to start the gateway,
   *  and starting a second copy of a running one is how ports get fought over. */
  health: string;
  /** how long to wait for `health` after starting (default 20s) */
  readyMs?: number;
  method?: string;
  headers?: Record<string, string>;
  tokenEnv?: string;
}

/** Rung 4 — the harness polls us; there is nothing to deliver to. */
export interface SubscribeRoute {
  mode: "subscribe";
  /** one line saying how this harness is wired to run the listen loop */
  hint?: string;
}

export type Route = InboundRoute | HeadlessRoute | GatewayRoute | SubscribeRoute;

export interface HarnessProfile {
  id: string;
  name?: string;
  routes: Route[];
}

export interface HarnessConfig {
  version: number;
  /** which profile to use when none is named */
  default?: string;
  harnesses: HarnessProfile[];
}

/**
 * The harnesses the framework knows how to drive with no configuration at all.
 *
 * Each is the harness's own documented headless invocation and nothing more —
 * one prompt in, one run, exit. They are DEFAULTS, not assertions that the
 * binary is installed: {@link inspect} checks PATH, and a machine with none of
 * them installed correctly reports rung 5 rather than pretending.
 *
 * A harness whose flags change, or one not listed here, is described in
 * `harnesses.json` instead; an entry there with the same id replaces the
 * built-in outright rather than merging into it, so what the file says is what
 * runs.
 */
export const BUILT_IN_HARNESSES: readonly HarnessProfile[] = [
  { id: "claude", name: "Claude Code", routes: [{ mode: "headless", command: "claude", args: ["-p", PROMPT_PLACEHOLDER] }] },
  { id: "codex", name: "Codex CLI", routes: [{ mode: "headless", command: "codex", args: ["exec", PROMPT_PLACEHOLDER] }] },
  { id: "gemini", name: "Gemini CLI", routes: [{ mode: "headless", command: "gemini", args: ["-p", PROMPT_PLACEHOLDER] }] },
  { id: "aider", name: "Aider", routes: [{ mode: "headless", command: "aider", args: ["--message", PROMPT_PLACEHOLDER] }] },
];

export function harnessesPath(): string {
  return homePath(HARNESSES_FILE);
}

/* ------------------------------------------------------------- validation */

function bad(where: string, why: string): never {
  throw new EnvError(
    `${harnessesPath()}: ${where} ${why}.\n` +
      `Fix or remove that entry — a malformed route is never guessed at, because the guess would be ` +
      `a process spawned or an endpoint called on the user's behalf.`,
  );
}

function asStringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(where, "must be an object of strings");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") bad(`${where}.${k}`, "must be a string");
    out[k] = v;
  }
  return out;
}

function httpUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") bad(where, "must be a URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return bad(where, `is not a usable URL (${value})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") bad(where, "must be http(s)");
  return value;
}

/** Validate one route from the config file. Throws {@link EnvError} naming it. */
function parseRoute(raw: unknown, where: string): Route {
  if (typeof raw !== "object" || raw === null) bad(where, "must be an object");
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  switch (mode) {
    case "inbound": {
      const route: InboundRoute = { mode: "inbound", url: httpUrl(r.url, `${where}.url`) };
      if (typeof r.method === "string") route.method = r.method;
      const headers = asStringMap(r.headers, `${where}.headers`);
      if (headers) route.headers = headers;
      if (typeof r.tokenEnv === "string") route.tokenEnv = r.tokenEnv;
      if (r.health !== undefined) route.health = httpUrl(r.health, `${where}.health`);
      return route;
    }
    case "gateway": {
      if (typeof r.start !== "string" || r.start === "") bad(`${where}.start`, "must be the command that starts the gateway");
      const route: GatewayRoute = {
        mode: "gateway",
        url: httpUrl(r.url, `${where}.url`),
        start: r.start,
        health: httpUrl(r.health, `${where}.health`),
      };
      if (typeof r.readyMs === "number") route.readyMs = r.readyMs;
      if (typeof r.method === "string") route.method = r.method;
      const headers = asStringMap(r.headers, `${where}.headers`);
      if (headers) route.headers = headers;
      if (typeof r.tokenEnv === "string") route.tokenEnv = r.tokenEnv;
      return route;
    }
    case "headless": {
      if (typeof r.command !== "string" || r.command === "") bad(`${where}.command`, "must name a binary");
      if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string")) {
        bad(`${where}.args`, "must be an array of strings");
      }
      const args = r.args as string[];
      const input = r.input === "stdin" ? "stdin" : "arg";
      if (input === "arg" && !args.some((a) => a.includes(PROMPT_PLACEHOLDER))) {
        bad(
          `${where}.args`,
          `must contain "${PROMPT_PLACEHOLDER}" (where the task prompt goes), or the route must set ` +
            `"input": "stdin". Without either, the harness would be launched with no task in it`,
        );
      }
      const route: HeadlessRoute = { mode: "headless", command: r.command, args, input };
      if (typeof r.cwd === "string") route.cwd = r.cwd;
      if (typeof r.timeoutMs === "number") route.timeoutMs = r.timeoutMs;
      return route;
    }
    case "subscribe": {
      const route: SubscribeRoute = { mode: "subscribe" };
      if (typeof r.hint === "string") route.hint = r.hint;
      return route;
    }
    default:
      return bad(`${where}.mode`, `must be one of ${LADDER.join(", ")} (got ${JSON.stringify(mode)})`);
  }
}

function parseProfile(raw: unknown, index: number): HarnessProfile {
  if (typeof raw !== "object" || raw === null) bad(`harnesses[${index}]`, "must be an object");
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id === "") bad(`harnesses[${index}].id`, "must be a non-empty string");
  if (!Array.isArray(p.routes) || p.routes.length === 0) {
    bad(`harnesses[${index}].routes`, "must be a non-empty array — a profile with no route can never be reached");
  }
  const profile: HarnessProfile = {
    id: p.id,
    routes: p.routes.map((r, i) => parseRoute(r, `harnesses[${index}].routes[${i}]`)),
  };
  if (typeof p.name === "string") profile.name = p.name;
  return profile;
}

/* ---------------------------------------------------------------- loading */

export interface LoadedHarnesses {
  profiles: HarnessProfile[];
  /** the configured default profile id, when the file names one */
  preferred: string | null;
  /** the config file, when one exists — for messages that must be actionable */
  source: string | null;
}

/**
 * Every profile this machine knows: the built-ins, with configured entries
 * replacing same-id built-ins and adding new ones.
 *
 * Replace rather than merge, deliberately. A user editing this file is
 * correcting the framework about their own machine — a harness whose flags
 * changed, a wrapper script, a binary somewhere odd — and a merge would leave
 * the framework's stale idea of the route half in place, which is the version
 * that then fails at 2am inside a daemon.
 */
export function loadHarnesses(): LoadedHarnesses {
  const file = harnessesPath();
  if (!existsSync(file)) return { profiles: [...BUILT_IN_HARNESSES], preferred: null, source: null };
  const raw = readJsonFile<Partial<HarnessConfig>>(file);
  const configured = Array.isArray(raw.harnesses) ? raw.harnesses.map(parseProfile) : [];
  const byId = new Map<string, HarnessProfile>();
  for (const p of BUILT_IN_HARNESSES) byId.set(p.id, p);
  for (const p of configured) byId.set(p.id, p);
  return {
    profiles: [...byId.values()],
    preferred: typeof raw.default === "string" && raw.default !== "" ? raw.default : null,
    source: file,
  };
}

/* ------------------------------------------------------------ PATH lookup */

/**
 * Resolve a command the way a shell would, without running one.
 *
 * Spawning `where`/`which` to answer "is this installed?" costs a process per
 * candidate and, on Windows, drags in a shell — which is exactly what the
 * delivery path refuses to use (see `bridge.ts`). Scanning PATH directly is
 * both cheaper and the same answer.
 */
export function resolveOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const isFile = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const exts =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
      : [""];
  // A path the caller wrote out is believed as written, then tried with each
  // PATHEXT suffix. A bare name searched on PATH is NOT tried bare on Windows:
  // an extensionless file there is not executable by CreateProcess, and several
  // are on a normal PATH (the Git-for-Windows POSIX tools), so accepting one
  // would report a harness as installed that cannot actually be spawned.
  const withExts = (base: string): string[] => exts.map((e) => base + e);
  if (command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    return [command, ...withExts(command)].find(isFile) ?? null;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const found = withExts(join(dir, command)).find(isFile);
    if (found !== undefined) return found;
  }
  return null;
}

/* ------------------------------------------------------------- the ladder */

/** One rung, and why it is or is not usable here. */
export interface RungReport {
  mode: DeliveryMode;
  available: boolean;
  /** one line a person can act on — never just "false" */
  detail: string;
}

async function probe(url: string): Promise<boolean> {
  try {
    return (await fetchWithTimeout(url, 2000)).ok;
  } catch {
    return false;
  }
}

async function inspectRoute(route: Route): Promise<RungReport> {
  switch (route.mode) {
    case "inbound": {
      if (route.health === undefined) {
        return { mode: "inbound", available: true, detail: `configured: ${route.url} (no health url to probe)` };
      }
      const up = await probe(route.health);
      return {
        mode: "inbound",
        available: up,
        detail: up ? `answering at ${route.url}` : `${route.health} did not answer — the harness's endpoint is not up`,
      };
    }
    case "headless": {
      const resolved = resolveOnPath(route.command);
      return {
        mode: "headless",
        available: resolved !== null,
        detail:
          resolved !== null
            ? `${route.command} → ${resolved}`
            : `${route.command} is not on PATH — install it, or point a route at it by absolute path`,
      };
    }
    case "gateway": {
      const up = await probe(route.health);
      return {
        mode: "gateway",
        available: true,
        detail: up ? `gateway already up at ${route.url}` : `gateway is down — the bridge will start it: ${route.start}`,
      };
    }
    case "subscribe":
      return {
        mode: "subscribe",
        available: true,
        detail: route.hint ?? "this harness polls for its own work; the framework supplies the listen command",
      };
  }
}

/**
 * Walk the ladder for one profile: the route it will actually use here, or null
 * for rung 5 — plus every rung that was tried, in ladder order.
 *
 * The ladder is reported whole rather than as just the winner, because the
 * interesting question when nothing works is which rungs were checked and what
 * each one was missing. "Not supported" is only actionable alongside that.
 */
export async function chooseRoute(profile: HarnessProfile): Promise<{ route: Route | null; ladder: RungReport[] }> {
  const ordered = [...profile.routes].sort((a, b) => LADDER.indexOf(a.mode) - LADDER.indexOf(b.mode));
  const ladder = await Promise.all(ordered.map(inspectRoute));
  const at = ladder.findIndex((r) => r.available);
  return { route: at >= 0 ? (ordered[at] ?? null) : null, ladder };
}

/**
 * Which harness to drive, in precedence order: what the caller named, then the
 * environment, then the configured default, then whichever profile actually has
 * a usable route here.
 *
 * Environment beats the stored default for the same reason `A2APP_TOKEN` does:
 * it is how a harness hands one run its own identity, and a per-run fact must
 * win over what the machine happens to remember.
 */
export async function selectProfile(
  loaded: LoadedHarnesses,
  named: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ profile: HarnessProfile; why: string } | { profile: null; why: string }> {
  const byId = (id: string): HarnessProfile | undefined => loaded.profiles.find((p) => p.id === id);
  const known = (): string => loaded.profiles.map((p) => p.id).join(", ");

  if (named !== undefined) {
    const found = byId(named);
    if (found === undefined) {
      return { profile: null, why: `no harness profile "${named}" — known profiles: ${known()}` };
    }
    return { profile: found, why: "named with --harness" };
  }
  const fromEnv = env["A2APP_HARNESS"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const found = byId(fromEnv.trim());
    if (found === undefined) {
      return { profile: null, why: `A2APP_HARNESS names "${fromEnv.trim()}", which is not a known profile: ${known()}` };
    }
    return { profile: found, why: "named by A2APP_HARNESS" };
  }
  if (loaded.preferred !== null) {
    const found = byId(loaded.preferred);
    if (found === undefined) {
      return { profile: null, why: `${harnessesPath()} sets "default": "${loaded.preferred}", which no profile defines` };
    }
    return { profile: found, why: `the default in ${harnessesPath()}` };
  }
  // Nothing was chosen, so detect. The first profile with a usable route wins,
  // which on a plain machine is whichever headless CLI is installed.
  for (const profile of loaded.profiles) {
    const { route } = await chooseRoute(profile);
    if (route !== null) return { profile, why: "detected on this machine (no harness named)" };
  }
  return { profile: null, why: `no harness profile has a usable route here (looked at: ${known()})` };
}
