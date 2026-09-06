/**
 * The conformance runner: loads a language-neutral YAML suite and executes each
 * check against a live app — over real HTTP (classes A/C) or by shelling the
 * `a2app` CLI (class B). Assertions branch on structure (status, machine codes,
 * JSON paths), never on prose, mirroring how a conforming client must behave.
 */
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface Expect {
  status?: number;
  exit?: number;
  /** exact equality at a dotted JSON path */
  match?: Record<string, unknown>;
  /** paths that must be present (not null/undefined) */
  has?: string[];
  /** paths that must be absent (null/undefined) */
  absent?: string[];
  /** array length at a path */
  len?: Record<string, number>;
  /** number of keys of an OBJECT at a path (`len` only works on arrays, and a
   *  describe level's `fields` is an object) */
  keys?: Record<string, number>;
  /**
   * Serialized size ceiling, in characters, for the whole response or for a
   * subtree of it.
   *
   * `maxChars` measures the response document; `maxCharsAt` measures one path
   * within it. This is what makes the per-response describe budget checkable —
   * the budget has been contractual since the first version of the protocol and
   * had no assertion behind it, which is how the reference adapter came to
   * exceed it unnoticed.
   *
   * Measured on the canonical JSON of the parsed document rather than the raw
   * body, so pretty-printing or a transport's whitespace cannot change the
   * verdict. The budget is a property of the content, not its formatting.
   */
  maxChars?: number;
  maxCharsAt?: Record<string, number>;
  /** substring present in the raw response body / stdout */
  contains?: string;
  /** capture values from the response into vars: { varName: "json.path" } */
  save?: Record<string, string>;
}

export interface HttpCheckSpec {
  method: string;
  path: string;
  token?: "full" | "readonly" | "none" | string;
  origin?: string;
  auth?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number>;
  body?: unknown;
}

export interface CliCheckSpec {
  args: string[];
}

export interface Check {
  name: string;
  request?: HttpCheckSpec;
  cli?: CliCheckSpec;
  expect: Expect;
}

export interface Suite {
  class: string;
  name: string;
  description?: string;
  checks: Check[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  failures: string[];
}

export interface SuiteResult {
  class: string;
  name: string;
  results: CheckResult[];
  passed: number;
  failed: number;
}

export interface RunContext {
  baseUrl: string;
  tokens: { full: string; readonly: string };
  /** node entry for the a2app CLI, and the temp project dir it operates on */
  cli?: { entry: string; projectDir: string };
  vars: Map<string, unknown>;
}

interface Actual {
  status?: number;
  exit?: number;
  json: unknown;
  body: string;
}

export function parseSuite(text: string): Suite {
  const doc = parseYaml(text) as Suite;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.checks)) {
    throw new Error("invalid suite: expected { class, name, checks: [...] }");
  }
  return doc;
}

/* ---------------------------------------------------------------- helpers */

function interpolate(value: unknown, vars: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_m, k: string) => String(vars.get(k.trim()) ?? ""));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars);
    return out;
  }
  return value;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function evaluate(expect: Expect, actual: Actual, vars: Map<string, unknown>): string[] {
  const failures: string[] = [];
  if (expect.status !== undefined && actual.status !== expect.status) {
    failures.push(`status: expected ${expect.status}, got ${actual.status}`);
  }
  if (expect.exit !== undefined && actual.exit !== expect.exit) {
    failures.push(`exit: expected ${expect.exit}, got ${actual.exit}`);
  }
  for (const [path, wantRaw] of Object.entries(expect.match ?? {})) {
    const want = interpolate(wantRaw, vars);
    const got = getPath(actual.json, path);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`match ${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  for (const path of expect.has ?? []) {
    const v = getPath(actual.json, path);
    if (v === undefined || v === null) failures.push(`has ${path}: missing`);
  }
  for (const path of expect.absent ?? []) {
    const v = getPath(actual.json, path);
    if (v !== undefined && v !== null) failures.push(`absent ${path}: present (${JSON.stringify(v)})`);
  }
  for (const [path, n] of Object.entries(expect.len ?? {})) {
    const arr = getPath(actual.json, path);
    if (!Array.isArray(arr) || arr.length !== n) {
      failures.push(`len ${path}: expected ${n}, got ${Array.isArray(arr) ? arr.length : "not-an-array"}`);
    }
  }
  for (const [path, n] of Object.entries(expect.keys ?? {})) {
    const obj = getPath(actual.json, path);
    const count = obj !== null && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj).length : null;
    if (count !== n) {
      failures.push(`keys ${path}: expected ${n}, got ${count === null ? "not-an-object" : count}`);
    }
  }
  if (expect.maxChars !== undefined) {
    const size = actual.json === null ? actual.body.length : JSON.stringify(actual.json).length;
    if (size > expect.maxChars) failures.push(`maxChars: ${size} chars exceeds the ${expect.maxChars} budget`);
  }
  for (const [path, limit] of Object.entries(expect.maxCharsAt ?? {})) {
    const value = getPath(actual.json, path);
    const size = JSON.stringify(value ?? null).length;
    if (size > limit) failures.push(`maxCharsAt ${path}: ${size} chars exceeds the ${limit} budget`);
  }
  if (expect.contains !== undefined && !actual.body.includes(expect.contains)) {
    failures.push(`contains: "${expect.contains}" not found`);
  }
  if (failures.length === 0) {
    for (const [name, path] of Object.entries(expect.save ?? {})) {
      vars.set(name, getPath(actual.json, path));
    }
  }
  return failures;
}

/* ------------------------------------------------------------- executors */

async function runHttp(spec: HttpCheckSpec, ctx: RunContext): Promise<Actual> {
  const spec2 = interpolate(spec, ctx.vars) as HttpCheckSpec;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const tokenSel = spec2.token ?? "none";
  if (tokenSel === "full") headers["x-a2app-token"] = ctx.tokens.full;
  else if (tokenSel === "readonly") headers["x-a2app-token"] = ctx.tokens.readonly;
  else if (tokenSel !== "none") headers["x-a2app-token"] = tokenSel;
  if (spec2.origin) headers["origin"] = spec2.origin;
  if (spec2.auth) headers["authorization"] = spec2.auth;
  Object.assign(headers, spec2.headers ?? {});

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(spec2.query ?? {})) qs.set(k, String(v));
  const url = `${ctx.baseUrl}${spec2.path}${qs.size ? `?${qs}` : ""}`;

  const init: RequestInit = { method: spec2.method, headers };
  if (spec2.body !== undefined) init.body = JSON.stringify(spec2.body);
  const res = await fetch(url, init);
  const body = await res.text();
  let json: unknown = null;
  try {
    json = body === "" ? null : JSON.parse(body);
  } catch {
    json = null;
  }
  return { status: res.status, json, body };
}

/**
 * Run the CLI as a child process. MUST be async (not spawnSync): the reference
 * app server runs in this same process, so a synchronous spawn would freeze the
 * event loop and the CLI child could never connect — a deadlock.
 */
function runCli(spec: CliCheckSpec, ctx: RunContext): Promise<Actual> {
  if (!ctx.cli) return Promise.resolve({ exit: -1, json: null, body: "class B skipped: a2app CLI not available" });
  const args = (interpolate(spec.args, ctx.vars) as string[]).map((a) =>
    a === "<APPDIR>" ? ctx.cli!.projectDir : a,
  );
  return new Promise<Actual>((resolve) => {
    const child = spawn(process.execPath, [ctx.cli!.entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ exit: code ?? -1, json, body: stdout + stderr });
    });
    child.on("error", () => resolve({ exit: -1, json: null, body: "failed to spawn CLI" }));
  });
}

/* ----------------------------------------------------------------- driver */

export async function runSuite(suite: Suite, ctx: RunContext): Promise<SuiteResult> {
  const results: CheckResult[] = [];
  for (const check of suite.checks) {
    let failures: string[];
    try {
      if (check.cli) {
        if (!ctx.cli) {
          results.push({ name: check.name, ok: true, failures: ["(skipped: CLI unavailable)"] });
          continue;
        }
        failures = evaluate(check.expect, await runCli(check.cli, ctx), ctx.vars);
      } else if (check.request) {
        failures = evaluate(check.expect, await runHttp(check.request, ctx), ctx.vars);
      } else {
        failures = ["check has neither `request` nor `cli`"];
      }
    } catch (e) {
      failures = [`threw: ${(e as Error).message}`];
    }
    results.push({ name: check.name, ok: failures.length === 0, failures });
  }
  const passed = results.filter((r) => r.ok).length;
  return { class: suite.class, name: suite.name, results, passed, failed: results.length - passed };
}
