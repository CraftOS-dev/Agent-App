/**
 * Project resolution and the A2App client factory.
 *
 * A project is any directory holding a `manifest.json` framework file. The CLI
 * is stack-agnostic: it never reads backend-specific config, only the manifest
 * (identity + pipeline) and the runtime credential files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { A2AppClient } from "@a2app/sdk";
import { readDevRecord } from "./instance.js";
import { identifyApp } from "./net.js";
import { AmbiguousAppError, find } from "./registry.js";
import { readJsonFile } from "./json.js";
import { log } from "./log.js";

/** manifest.json (framework file). */
export interface Manifest {
  id: string;
  name: string;
  agentAppVersion: string;
  adapterVersion: string;
  appVersion?: string;
  authMode: "none" | "multi-user";
  /**
   * The app's organizing units. Every entity and operation belongs to exactly
   * one, and these are the rows of describe's root level. Declared before
   * anything that belongs to one.
   */
  modules: { name: string; summary?: string }[];
  modificationLock?: boolean;
  capabilities?: Record<string, unknown>;
  pipeline: { install: string; build: string; start: string; health: string };
  /** non-normative: launch port a host assigns; read by operate commands */
  port?: number;
}

export interface Project {
  dir: string;
  manifest: Manifest;
  baseUrl: string;
}

/**
 * Resolve a project by directory, or — when that is not an Agent App — by the
 * id or name of a registered one (framework section 5.6), so an agent can say
 * `a2app "Kanban Board" data schema` without tracking paths. The manifest stays
 * authoritative; the registry only supplies the location.
 */
/**
 * Is this string addressing an app over the network rather than on disk?
 *
 * Only `http:` and `https:` qualify. Any other scheme is rejected outright
 * rather than falling through to be read as a directory name: `file:///etc` is
 * not a path this CLI should quietly try to open, and a mistyped scheme should
 * say so rather than report "not an Agent App".
 */
export function isRemoteAddress(app: string): boolean {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(app)) return false;
  let url: URL;
  try {
    url = new URL(app);
  } catch {
    throw new UsageError(`Not a usable app address: ${app}`);
  }
  if (url.protocol === "http:" || url.protocol === "https:") return true;
  throw new UsageError(
    `An app is addressed by directory, by registered id/name, or by http(s) URL — not by "${url.protocol}//".`,
  );
}

export function loadProject(projectDir: string): Project {
  // A URL reaches an app whose files are somewhere else, and every caller of
  // this function needs those files. Refusing here is what keeps "operated but
  // never modified" from being a rule an agent has to remember: there is no
  // directory for a build or lifecycle command to act on, so it cannot act.
  if (isRemoteAddress(projectDir)) {
    throw new UsageError(
      `${projectDir} is a remote app — it can be operated, not modified.\n` +
        `Building, evolving and lifecycle commands act on an app's files, which are on its own host. ` +
        `Use \`a2app ${projectDir} …\` to operate it.`,
    );
  }
  let dir = resolve(projectDir);
  if (!existsSync(join(dir, "manifest.json"))) {
    // An ambiguous name must not be guessed at: surface the candidates.
    let registered;
    try {
      registered = find(projectDir);
    } catch (err) {
      if (err instanceof AmbiguousAppError) throw new UsageError(err.message);
      throw err;
    }
    if (registered !== null && existsSync(join(resolve(registered.path), "manifest.json"))) {
      dir = resolve(registered.path);
    }
  }
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new UsageError(
      `Not an Agent App (no manifest.json): ${dir}. Pass a project directory, or a registered app id/name — see \`agent-app list\`.`,
    );
  }
  const manifest = readJsonFile(manifestPath) as Manifest;
  const port = manifest.port ?? 8090;
  return { dir, manifest, baseUrl: `http://127.0.0.1:${port}` };
}

/** The project's agent credential, or null when it predates it. */
export function readAgentToken(dir: string): string | null {
  const file = join(dir, ".agent-token");
  if (!existsSync(file)) return null;
  const value = readFileSync(file, "utf8").trim();
  return value === "" ? null : value;
}

/**
 * Where operate traffic for this project goes right now: the DEV instance when
 * one is recorded, else the live app on `manifest.port`.
 *
 * The dev record routes ALL agent traffic to the candidate while it is up —
 * that is what keeps test writes during a modify out of real user data (threat
 * B2). A stale record is a LOUD failure, never a silent fall-back to live: a
 * fallback here is exactly the path by which disposable test records would
 * land in the user's database.
 *
 * The route is verified before use: the dev port must answer as THIS app. The
 * check costs one identity round trip per command, and it is what makes "I am
 * talking to the candidate" a structural fact rather than an assumption.
 */
export async function operateTarget(project: Project): Promise<{ baseUrl: string; env: "dev" | "live" }> {
  const dev = readDevRecord(project.dir);
  if (dev === null) return { baseUrl: project.baseUrl, env: "live" };
  const answeringId = await identifyApp(dev.port);
  if (answeringId !== project.manifest.id) {
    throw new EnvError(
      `a dev instance is recorded (port ${dev.port}) but is not answering as this app` +
        `${answeringId !== null ? ` (port is held by app id ${answeringId})` : ""}. ` +
        `Operate commands target the dev instance while one is recorded — never live — so test data ` +
        `cannot leak into the live database.\n` +
        `  Restart it:  agent-app ${project.dir} dev\n` +
        `  Abandon it:  agent-app ${project.dir} stop --dev`,
    );
  }
  // Say WHERE this answer comes from, every time. The routed commands are the
  // one surface every caller reads — an agent that joined mid-modify learns the
  // state here or not at all. Stderr, so machine-readable stdout is untouched;
  // compact, because it rides on every routed response.
  log.info(
    `answering from the DEV instance :${dev.port} (candidate; disposable database) — ` +
      `\`agent-app <app> promote\` when done · \`agent-app <app> stop --dev\` to abandon`,
  );
  return { baseUrl: dev.url, env: "dev" };
}

/** Build an A2App client for a running project, routed to the dev instance
 *  while one is up (see {@link operateTarget}). `agentName` self-declares the
 *  caller in the audit log (X-A2App-Agent). */
export async function clientFor(project: Project): Promise<A2AppClient> {
  const target = await operateTarget(project);
  return new A2AppClient({
    baseUrl: target.baseUrl,
    token: readAgentToken(project.dir),
    agentName: process.env["A2APP_AGENT"] ?? "a2app-cli",
    authToken: await principalToken(project, target.baseUrl),
  });
}

/**
 * The acting user's own auth token for multi-user apps. v1 reads a project-local
 * `.principal` file `{ "authUrl": "...", "identity": "...", "password": "..." }`;
 * absent on single-user (`authMode: none`) apps.
 */
async function principalToken(project: Project, baseUrl: string): Promise<string | null> {
  const file = join(project.dir, ".principal");
  if (!existsSync(file)) return null;
  try {
    const cred = readJsonFile(file) as {
      authUrl: string;
      identity: string;
      password: string;
    };
    const res = await fetch(`${baseUrl}${cred.authUrl}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity: cred.identity, password: cred.password }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { token: string }).token;
  } catch {
    return null;
  }
}

/** A usage error maps to CLI exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * An environment/filesystem fault (unwritable home, permission denied, disk
 * full) — distinct from a gate/guard rejection. It still maps to exit 1, but is
 * surfaced with a framed, actionable message rather than a bare errno, so an
 * operator can tell "fix your environment and retry" from "your request was
 * validly rejected".
 */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}
