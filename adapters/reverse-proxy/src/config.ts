/**
 * The declarative side of an adopted app: `sidecar.json` — how the app starts,
 * and which of its routes each operation reaches — read together with the two
 * framework files it completes: `manifest.json` (identity, authMode, modules)
 * and `operations.json` (what each operation is and takes).
 *
 *   {
 *     "upstream": {
 *       "command": ["node", "server.js"],       // argv, never run through a shell
 *       "cwd": "upstream",                       // where the adopted source lives
 *       "port": "auto",                          // or the fixed port the app binds
 *       "env": { "PORT": "{port}" },             // {port} and {dataDir} are filled in
 *       "health": "/health"                      // answers < 400 once the app is up
 *     },
 *     "operations": {
 *       "list-notes": { "method": "GET", "path": "/notes" },
 *       "delete-note": { "method": "DELETE", "path": "/notes/{id}" }
 *     }
 *   }
 *
 * One loader serves both callers: the runner, which refuses to start on any
 * problem, and the toolkit's gate step (`a2app-sidecar --check`), which reports
 * them. So the gate can never pass a mapping the sidecar would refuse at boot.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { InMemoryStateStore, type ModuleDecl, type ParamDef } from "@a2app/adapter-core";
import { createReverseProxy, PATH_PARAM, PROXY_METHODS, type ProxyMethod, type ProxyOperation } from "./proxy.js";

export const MANIFEST_FILE = "manifest.json";
export const OPERATIONS_FILE = "operations.json";
export const SIDECAR_FILE = "sidecar.json";

/**
 * How long the app has to answer its health path once started. `agent-app
 * serve` gives a whole launch 20 s, so the default leaves the sidecar time to
 * say why it gave up before serve stops waiting.
 */
export const DEFAULT_START_TIMEOUT_MS = 15_000;

/** Where the adopted source lives when `upstream.cwd` does not say. */
const DEFAULT_UPSTREAM_DIR = "upstream";

export interface UpstreamSpec {
  /** argv; run directly, never through a shell */
  command: string[];
  /** the app's working directory, relative to the app directory */
  cwd: string;
  /** the port the app binds, or `auto` for a free one handed over as `{port}` */
  port: number | "auto";
  /** declared environment, with `{port}` / `{dataDir}` still unexpanded */
  env: Record<string, string>;
  /** a path that answers below 400 once the app is up */
  health: string;
  /** per-call deadline for a forwarded operation */
  timeoutMs?: number;
  startTimeoutMs: number;
}

export interface OperationMapping {
  method: ProxyMethod;
  path: string;
  send?: "body" | "query";
}

export interface SidecarSpec {
  upstream: UpstreamSpec;
  operations: Record<string, OperationMapping>;
}

/** The parts of `manifest.json` the sidecar serves from. */
export interface AdoptedManifest {
  id: string;
  name: string;
  authMode: "none" | "multi-user";
  modules: ModuleDecl[];
  port?: number;
}

export interface AdoptedApp {
  dir: string;
  manifest: AdoptedManifest;
  sidecar: SidecarSpec;
  /** operations.json's declarations, each joined with its mapping */
  operations: ProxyOperation[];
}

export type LoadResult = { ok: true; app: AdoptedApp } | { ok: false; problems: string[] };

/** The values `sidecar.json` may splice into the app's argv and environment. */
export interface UpstreamTokens {
  /** the port the app is to bind */
  port: string;
  /** a directory for the app's own data, inside the framework's data directory
   *  — so a dev instance gets a fresh one, and backups cover it */
  dataDir: string;
}

const TOKEN = /\{(port|dataDir)\}/g;

export function expandTokens(value: string, tokens: UpstreamTokens): string {
  return value.replace(TOKEN, (_m, name: keyof UpstreamTokens) => tokens[name]);
}

/** Whether the declared argv or environment hands the app this token. */
export function mentionsToken(upstream: Pick<UpstreamSpec, "command" | "env">, name: keyof UpstreamTokens): boolean {
  const needle = `{${name}}`;
  return [...upstream.command, ...Object.values(upstream.env)].some((v) => v.includes(needle));
}

/* ------------------------------------------------------------- reading */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const isPositiveInteger = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const UPSTREAM_KEYS = new Set(["command", "cwd", "port", "env", "health", "timeoutMs", "startTimeoutMs"]);
const MAPPING_KEYS = new Set(["method", "path", "send"]);

function readJson(dir: string, file: string, problems: string[]): unknown {
  const path = resolve(dir, file);
  if (!existsSync(path)) {
    problems.push(`${file}: missing`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    problems.push(`${file}: not valid JSON (${(e as Error).message})`);
    return undefined;
  }
}

/** Keys the reader does not know are almost always typos (`comand`), and a
 *  typo silently ignored is a setting silently not applied. */
function unknownKeys(problems: string[], where: string, obj: Json, known: Set<string>): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) problems.push(`${where}: unknown key "${key}" (expected one of ${[...known].join(", ")})`);
  }
}

function readManifest(raw: unknown, problems: string[]): AdoptedManifest | null {
  if (!isObject(raw)) {
    if (raw !== undefined) problems.push(`${MANIFEST_FILE}: must be a JSON object`);
    return null;
  }
  const { id, name, authMode, modules, port } = raw;
  const before = problems.length;
  if (typeof id !== "string" || id === "") problems.push(`${MANIFEST_FILE}: "id" must be a non-empty string`);
  if (typeof name !== "string" || name === "") problems.push(`${MANIFEST_FILE}: "name" must be a non-empty string`);
  if (authMode !== undefined && authMode !== "none" && authMode !== "multi-user") {
    problems.push(`${MANIFEST_FILE}: "authMode" must be "none" or "multi-user"`);
  }
  if (!Array.isArray(modules) || !modules.every((m) => isObject(m) && typeof m.name === "string")) {
    problems.push(`${MANIFEST_FILE}: "modules" must be a list of { name, summary? }`);
  }
  if (port !== undefined && !(Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)) {
    problems.push(`${MANIFEST_FILE}: "port" must be an integer between 1 and 65535`);
  }
  if (problems.length > before) return null;
  return {
    id: id as string,
    name: name as string,
    authMode: authMode === "multi-user" ? "multi-user" : "none",
    modules: (modules as Json[]).map((m) => ({
      name: m.name as string,
      ...(typeof m.summary === "string" ? { summary: m.summary } : {}),
    })),
    ...(typeof port === "number" ? { port } : {}),
  };
}

/** One operations.json entry, before it is joined with its mapping. */
type Declaration = Omit<ProxyOperation, "method" | "path" | "send">;

function readDeclarations(raw: unknown, problems: string[]): Declaration[] | null {
  if (raw === undefined) return null;
  if (!isObject(raw) || !Array.isArray(raw.operations)) {
    problems.push(`${OPERATIONS_FILE}: must be { "operations": [ … ] }`);
    return null;
  }
  const out: Declaration[] = [];
  for (const entry of raw.operations as unknown[]) {
    if (!isObject(entry) || typeof entry.name !== "string") {
      problems.push(`${OPERATIONS_FILE}: every operation needs a "name"`);
      continue;
    }
    const { name, destructive, module, params, description, readOnly, idempotent } = entry;
    const where = `${OPERATIONS_FILE}: ${name}`;
    const before = problems.length;
    if (typeof destructive !== "boolean") problems.push(`${where}: "destructive" (boolean) is required`);
    if (typeof module !== "string" || module === "") problems.push(`${where}: "module" is required`);
    if (!isObject(params)) problems.push(`${where}: "params" must be an object of typed parameters ({} if it takes none)`);
    // An adopted app is operate-only: there is no entity for an operation to
    // act on, and no record to evaluate a condition against.
    if (entry.entity !== undefined || entry.appliesWhen !== undefined) {
      problems.push(`${where}: "entity"/"appliesWhen" do not apply — an adopted app has no entities, only module-level operations`);
    }
    if (problems.length > before) continue;
    out.push({
      name,
      destructive: destructive as boolean,
      module: module as string,
      params: params as Record<string, ParamDef>,
      ...(typeof description === "string" ? { description } : {}),
      ...(readOnly === true ? { readOnly: true } : {}),
      ...(idempotent === true ? { idempotent: true } : {}),
    });
  }
  return out;
}

function readUpstream(dir: string, raw: unknown, manifest: AdoptedManifest | null, problems: string[]): UpstreamSpec | null {
  const where = `${SIDECAR_FILE}: upstream`;
  if (!isObject(raw)) {
    problems.push(`${where}: required — the object that says how the adopted app starts`);
    return null;
  }
  unknownKeys(problems, where, raw, UPSTREAM_KEYS);
  const before = problems.length;

  const command = raw.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string" && a !== "")) {
    problems.push(
      `${where}.command: must be a non-empty list of strings — the argv that starts the app, run without a shell (e.g. ["node", "server.js"])`,
    );
  }

  const cwd = raw.cwd === undefined ? DEFAULT_UPSTREAM_DIR : raw.cwd;
  if (typeof cwd !== "string" || cwd === "" || isAbsolute(cwd)) {
    problems.push(`${where}.cwd: must be a directory relative to the app (default "${DEFAULT_UPSTREAM_DIR}")`);
  } else {
    const rel = relative(dir, resolve(dir, cwd));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      problems.push(`${where}.cwd: "${cwd}" must be a directory inside the app, beside its framework files`);
    } else if (!existsSync(resolve(dir, cwd)) || !statSync(resolve(dir, cwd)).isDirectory()) {
      problems.push(`${where}.cwd: "${cwd}/" does not exist — put the adopted app's source there`);
    }
  }

  const port = raw.port;
  if (port !== "auto" && !(Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536)) {
    problems.push(`${where}.port: must be "auto" or the port the app binds (1–65535)`);
  } else if (manifest?.port !== undefined && port === manifest.port) {
    problems.push(`${where}.port: ${port} is the port this app is served on — the adopted app needs a port of its own`);
  }

  const env = raw.env === undefined ? {} : raw.env;
  if (!isObject(env)) {
    problems.push(`${where}.env: must be an object of string values`);
  } else {
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_NAME.test(key)) problems.push(`${where}.env: "${key}" is not an environment variable name`);
      if (typeof value !== "string") problems.push(`${where}.env.${key}: must be a string`);
    }
  }

  const health = raw.health;
  if (typeof health !== "string" || !health.startsWith("/")) {
    problems.push(`${where}.health: required — a path on the app (starting with "/") that answers below 400 once it is up`);
  }
  for (const key of ["timeoutMs", "startTimeoutMs"] as const) {
    if (raw[key] !== undefined && !isPositiveInteger(raw[key])) problems.push(`${where}.${key}: must be a positive integer`);
  }
  if (problems.length > before) return null;

  const spec: UpstreamSpec = {
    command: command as string[],
    cwd: cwd as string,
    port: port as number | "auto",
    env: env as Record<string, string>,
    health: health as string,
    startTimeoutMs: (raw.startTimeoutMs as number | undefined) ?? DEFAULT_START_TIMEOUT_MS,
    ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
  };
  // With a port picked at each boot, something has to tell the app which one.
  if (spec.port === "auto" && !mentionsToken(spec, "port")) {
    problems.push(`${where}.port: "auto" picks a free port at each boot, so command or env must hand it over as {port} (e.g. "env": { "PORT": "{port}" })`);
    return null;
  }
  return spec;
}

function readMapping(name: string, raw: unknown, decl: Declaration | undefined, problems: string[]): OperationMapping | null {
  const where = `${SIDECAR_FILE}: operations.${name}`;
  if (!isObject(raw)) {
    problems.push(`${where}: must be { "method", "path", "send"? }`);
    return null;
  }
  unknownKeys(problems, where, raw, MAPPING_KEYS);
  const before = problems.length;
  const method = typeof raw.method === "string" ? raw.method.toUpperCase() : raw.method;
  if (!(PROXY_METHODS as readonly unknown[]).includes(method)) {
    problems.push(`${where}.method: must be one of ${PROXY_METHODS.join(", ")}`);
  }
  const path = raw.path;
  if (typeof path !== "string" || !/^\/\S*$/.test(path)) {
    problems.push(`${where}.path: must be the app's own route, starting with "/" (e.g. "/notes/{id}")`);
  }
  if (raw.send !== undefined && raw.send !== "body" && raw.send !== "query") {
    problems.push(`${where}.send: must be "body" or "query"`);
  } else if (raw.send === "body" && method === "GET") {
    problems.push(`${where}.send: a GET carries no body — send its arguments as "query"`);
  }
  if (typeof path === "string" && decl !== undefined) {
    // A path segment the caller could leave out would reach a different route,
    // so every one must be a declared, required parameter.
    for (const [, key] of path.matchAll(PATH_PARAM)) {
      const param = decl.params[key!];
      if (param === undefined) problems.push(`${where}.path: {${key}} is not a parameter of ${name} in ${OPERATIONS_FILE}`);
      else if (param.required !== true) problems.push(`${where}.path: {${key}} fills a path segment, so ${name}'s "${key}" must be required`);
    }
  }
  if (problems.length > before) return null;
  return {
    method: method as ProxyMethod,
    path: path as string,
    ...(raw.send !== undefined ? { send: raw.send as "body" | "query" } : {}),
  };
}

/**
 * Read an adopted app's declarations and join them: every operation in
 * operations.json must resolve to a mapping in sidecar.json, and every mapping
 * must name a declared operation.
 */
export function loadAdoptedApp(dir: string): LoadResult {
  const problems: string[] = [];
  const manifest = readManifest(readJson(dir, MANIFEST_FILE, problems), problems);
  const declarations = readDeclarations(readJson(dir, OPERATIONS_FILE, problems), problems);
  const raw = readJson(dir, SIDECAR_FILE, problems);

  if (raw !== undefined && !isObject(raw)) problems.push(`${SIDECAR_FILE}: must be a JSON object`);
  const sidecar = isObject(raw) ? raw : null;
  if (sidecar) unknownKeys(problems, SIDECAR_FILE, sidecar, new Set(["upstream", "operations"]));

  const upstream = sidecar ? readUpstream(dir, sidecar.upstream, manifest, problems) : null;

  const mappings: Record<string, OperationMapping> = {};
  const declared = new Map((declarations ?? []).map((d) => [d.name, d]));
  if (sidecar) {
    const rawMappings = sidecar.operations === undefined ? {} : sidecar.operations;
    if (!isObject(rawMappings)) {
      problems.push(`${SIDECAR_FILE}: "operations" must map each operation name to { "method", "path", "send"? }`);
    } else {
      for (const [name, entry] of Object.entries(rawMappings)) {
        if (declarations !== null && !declared.has(name)) {
          problems.push(`${SIDECAR_FILE}: operations.${name} maps an operation ${OPERATIONS_FILE} does not declare`);
          continue;
        }
        const mapping = readMapping(name, entry, declared.get(name), problems);
        if (mapping) mappings[name] = mapping;
      }
      for (const name of declared.keys()) {
        if (!(name in rawMappings)) {
          problems.push(`${OPERATIONS_FILE}: ${name} resolves to no mapping — add operations.${name} to ${SIDECAR_FILE}`);
        }
      }
    }
  }

  if (problems.length > 0 || !manifest || !declarations || !upstream) {
    return { ok: false, problems };
  }

  const operations: ProxyOperation[] = declarations.map((d) => ({ ...d, ...mappings[d.name]! }));

  // Last, the check the adapter itself runs at construction (modules declared,
  // names legal, and so on), so a model the served surface would refuse can
  // never pass here first. A throwaway in-memory store keeps it side-effect free.
  try {
    createReverseProxy(
      {
        appId: manifest.id,
        appName: manifest.name,
        authMode: manifest.authMode,
        upstreamBaseUrl: "http://127.0.0.1",
        operations,
        modules: manifest.modules,
      },
      { store: new InMemoryStateStore(manifest.id) },
    );
  } catch (e) {
    return { ok: false, problems: [(e as Error).message] };
  }

  return { ok: true, app: { dir, manifest, sidecar: { upstream, operations: mappings }, operations } };
}
