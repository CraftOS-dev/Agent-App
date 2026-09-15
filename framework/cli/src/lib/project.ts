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
import { AmbiguousAppError, find } from "./registry.js";
import { readJsonFile } from "./json.js";

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
  /** non-normative safe-evolve marker stamped by `agent-app dev` */
  env?: "dev" | "live";
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
export function loadProject(projectDir: string): Project {
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

/** Build an A2App client for a running project. `agentName` self-declares the
 *  caller in the audit log (X-A2App-Agent). */
export async function clientFor(project: Project): Promise<A2AppClient> {
  return new A2AppClient({
    baseUrl: project.baseUrl,
    token: readAgentToken(project.dir),
    agentName: process.env["A2APP_AGENT"] ?? "a2app-cli",
    authToken: await principalToken(project),
  });
}

/**
 * The acting user's own auth token for multi-user apps. v1 reads a project-local
 * `.principal` file `{ "authUrl": "...", "identity": "...", "password": "..." }`;
 * absent on single-user (`authMode: none`) apps.
 */
async function principalToken(project: Project): Promise<string | null> {
  const file = join(project.dir, ".principal");
  if (!existsSync(file)) return null;
  try {
    const cred = readJsonFile(file) as {
      authUrl: string;
      identity: string;
      password: string;
    };
    const res = await fetch(`${project.baseUrl}${cred.authUrl}`, {
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
