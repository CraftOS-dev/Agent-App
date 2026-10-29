/**
 * Packages from a harness: the marketplace, inspect and install, as the agent
 * tools and the manager UIs drive them (framework packaging §2–§8).
 *
 * Nothing here re-implements the install pipeline. It writes the argv of the
 * CLI's `catalogue`, `inspect` and `install`, runs `agent-app`, and reads what
 * it prints, so an app installed from any harness arrives exactly as one
 * installed from a terminal.
 *
 * An install takes as long as its slowest step (a 512 MiB download, then the
 * app's own `npm install`), so a UI never holds one HTTP request open for it.
 * It starts a job and polls it, and the job follows `install --events` line by
 * line, so every poll shows the step the pipeline is on. The client has no
 * timeout at all, so none is shorter than the CLI's own.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { runA2App, type CliResult } from "./cli.js";

/** The install pipeline's steps, in order (§4). `--events` names a step by these. */
export const INSTALL_STEPS = [
  "acquire",
  "inspect",
  "sanitize",
  "revendor",
  "customize",
  "place",
  "register",
  "dependencies",
  "gate",
  "serve",
  "open",
] as const;

export type StepStatus = "start" | "done" | "failed" | "skipped";

/** One `{ "event": "step" }` line of `install --events`: a step starting, ending, failing, or not running. */
export interface StepEvent {
  event: "step";
  step: string;
  status: StepStatus;
  /** why a `skipped` step does not run */
  reason?: string;
  /** why a `failed` step failed */
  error?: string;
  [detail: string]: unknown;
}

/** The last line of `install --events`: the install's result document. */
export interface ResultEvent {
  event: "result";
  ok: boolean;
  [field: string]: unknown;
}

export type InstallEvent = StepEvent | ResultEvent;

const STATUSES: ReadonlySet<string> = new Set<StepStatus>(["start", "done", "failed", "skipped"]);

/** One stdout line of `install --events`, or null for anything that is not one of its events. */
export function parseInstallEvent(line: string): InstallEvent | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const e = doc as Record<string, unknown>;
  if (e.event === "step" && typeof e.step === "string" && typeof e.status === "string" && STATUSES.has(e.status)) {
    return e as StepEvent;
  }
  if (e.event === "result" && typeof e.ok === "boolean") return e as ResultEvent;
  return null;
}

/* ------------------------------------------------------------------- argv */

/** What to install, and how (`agent-app install`). Exactly one of `id` and `from`. */
export interface InstallRequest {
  /** a catalogue id (see `agent-app catalogue`) */
  id?: string;
  /** a zip, a folder, `github:<owner>/<repo>[@<ref>][/<path>]`, a github.com URL, or `git+<url>[#<ref>]` */
  from?: string;
  /** the marketplace a catalogue id is read from (`--source`) */
  source?: string;
  /** a new or empty folder to install into (`--into`); default `$A2APP_HOME/apps/<name>` */
  into?: string;
  name?: string;
  /** `--set KEY=VALUE`, one per entry: a catalogue app's customizable fields */
  set?: Record<string, unknown>;
  /** install the files only: no dependencies, no build, no launch */
  noStart?: boolean;
  /** show the app to the person once it runs */
  open?: boolean;
}

const given = (v: unknown): v is NonNullable<unknown> => v !== undefined && v !== null;

/** A request as a tool receives it from a model: the same fields, of any JSON type. Each is passed as `String(value)`. */
export type LooseRequest = { [K in keyof InstallRequest]?: unknown };

/** `install <id> | --from <source>` and its flags, for the build binary. */
export function installArgv(req: LooseRequest): string[] {
  const argv = ["install"];
  if (given(req.id)) argv.push(String(req.id));
  if (given(req.from)) argv.push("--from", String(req.from));
  if (given(req.source)) argv.push("--source", String(req.source));
  if (given(req.into)) argv.push("--into", String(req.into));
  if (given(req.name)) argv.push("--name", String(req.name));
  const set = req.set !== null && typeof req.set === "object" && !Array.isArray(req.set) ? (req.set as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(set)) argv.push("--set", `${key}=${String(value)}`);
  if (req.noStart === true) argv.push("--no-start");
  if (req.open === true) argv.push("--open");
  return argv;
}

/** `inspect <id> | --from <source>`: stage it, report what it is; installs nothing. */
export function inspectArgv(req: Pick<LooseRequest, "id" | "from" | "source">): string[] {
  const argv = ["inspect"];
  if (given(req.id)) argv.push(String(req.id));
  if (given(req.from)) argv.push("--from", String(req.from));
  if (given(req.source)) argv.push("--source", String(req.source));
  return argv;
}

/** `catalogue`: the marketplace's apps. It always prints JSON; there is no `--json`. */
export function catalogueArgv(req: { search?: unknown; source?: unknown }): string[] {
  const argv = ["catalogue"];
  if (given(req.search) && String(req.search).trim() !== "") argv.push("--search", String(req.search));
  if (given(req.source) && String(req.source).trim() !== "") argv.push("--source", String(req.source));
  return argv;
}

/* ---------------------------------------------------------------- install */

/**
 * Run `install … --events`, calling `onStep` for each step line as the CLI
 * writes it. Resolves once the CLI exits, with `json` set to the result
 * document (the last line, less its `event` key) — null when the CLI refused
 * the arguments before the pipeline started, which it reports on stderr.
 */
export async function runInstall(frameworkBin: string, req: InstallRequest, onStep: (event: StepEvent) => void): Promise<CliResult> {
  let result: Record<string, unknown> | null = null;
  const r = await runA2App(frameworkBin, [...installArgv(req), "--events"], {
    onLine(line) {
      const event = parseInstallEvent(line);
      if (event === null) return;
      if (event.event === "step") onStep(event);
      else {
        const { event: _event, ...rest } = event;
        result = rest;
      }
    },
  });
  return { ...r, json: result };
}

/** Why a CLI call did not succeed, as the person should read it: the result's own `error`, else the CLI's diagnostics. */
export function failureOf(r: CliResult): string {
  const doc = r.json as { error?: unknown } | null;
  if (doc !== null && typeof doc === "object" && typeof doc.error === "string") return doc.error;
  return (r.stderr || r.stdout).trim() || `exit ${r.code}`;
}

/** A step's latest state in a job: its last event, less the `event` key. */
export type StepState = Omit<StepEvent, "event">;

/** One install a UI started, as its polls see it. */
export interface InstallJob {
  id: string;
  request: InstallRequest;
  /** each step's latest state, in the order the pipeline reached them */
  steps: StepState[];
  done: boolean;
  /** the install succeeded (and, unless `--no-start`, the app is serving) */
  ok: boolean;
  /** the CLI's exit code, once it exits */
  code: number | null;
  /** the CLI's result document (§8), once it prints one */
  result: Record<string, unknown> | null;
  /** why it failed, when it failed without a gate report to show */
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * The installs a UI has started. Each runs `install --events` in the
 * background; its job is updated from every line, and kept for `keepMs` after
 * it ends so a page that polls late (or reloads) still sees how it ended.
 */
export class InstallJobs {
  private readonly jobs = new Map<string, InstallJob>();

  constructor(
    private readonly frameworkBin: string,
    private readonly keepMs = 60 * 60 * 1000,
  ) {}

  start(request: InstallRequest, onEnd?: (job: InstallJob) => void): InstallJob {
    this.prune();
    const job: InstallJob = {
      id: randomBytes(8).toString("hex"),
      request,
      steps: [],
      done: false,
      ok: false,
      code: null,
      result: null,
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(job.id, job);
    const track = (e: StepEvent): void => {
      const { event: _event, ...state } = e;
      const at = job.steps.findIndex((s) => s.step === e.step);
      if (at < 0) job.steps.push(state);
      else job.steps[at] = state;
    };
    void runInstall(this.frameworkBin, request, track).then((r) => {
      const result = r.json as Record<string, unknown> | null;
      job.code = r.code;
      job.result = result;
      job.ok = r.ok && result?.["ok"] === true;
      // A gate failure is reported by the result itself (installed, with its failures); anything else by its error.
      const gate = result?.["gate"] as { ok?: unknown } | undefined;
      job.error = job.ok || (result !== null && gate?.ok === false) ? null : failureOf(r);
      job.endedAt = new Date().toISOString();
      job.done = true;
      try {
        onEnd?.(job);
      } catch {
        // The job's outcome stands; what `onEnd` tidies up afterwards is best effort.
      }
    });
    return job;
  }

  get(id: string): InstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  private prune(): void {
    const cutoff = Date.now() - this.keepMs;
    for (const [id, job] of this.jobs) {
      if (job.done && job.endedAt !== null && Date.parse(job.endedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/* ---------------------------------------------------------------- uploads */

/** The most an uploaded package may be: the most `install` reads (§2). */
export const UPLOAD_LIMIT = 512 * 1024 * 1024;

/** How long an upload waits to be installed before it is swept. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Where a manager keeps uploaded zips until they are installed: private to this user. */
export function uploadsDir(): string {
  return join(tmpdir(), "a2app-uploads");
}

/** Whether `file` is an upload this machine's managers hold (and so theirs to delete). */
export function isUpload(file: string): boolean {
  const rel = relative(uploadsDir(), resolve(file));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export class UploadTooLargeError extends Error {
  constructor() {
    super(`the file is over the ${UPLOAD_LIMIT / 1024 / 1024} MiB a package may be`);
    this.name = "UploadTooLargeError";
  }
}

/** Remove uploads nobody installed within a day. */
function sweepUploads(dir: string): void {
  const cutoff = Date.now() - UPLOAD_TTL_MS;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      /* gone meanwhile */
    }
  }
}

/**
 * Save an uploaded zip to a fresh private file and return its path, for
 * `inspect --from` and `install --from`. The size is bounded while bytes
 * arrive, and a declared size over the bound is refused before any is read.
 * Nothing is unpacked or interpreted here: that is the CLI's job, with every
 * check it makes.
 */
export async function saveUpload(body: AsyncIterable<Uint8Array>, declaredLength?: number): Promise<string> {
  if (declaredLength !== undefined && declaredLength > UPLOAD_LIMIT) throw new UploadTooLargeError();
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepUploads(dir);
  const file = join(dir, `${Date.now()}-${randomBytes(8).toString("hex")}.zip`);
  async function* bounded(): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    for await (const chunk of body) {
      bytes += chunk.length;
      if (bytes > UPLOAD_LIMIT) throw new UploadTooLargeError();
      yield chunk;
    }
  }
  try {
    await pipeline(bounded(), createWriteStream(file, { flags: "wx", mode: 0o600 }));
  } catch (err) {
    rmSync(file, { force: true });
    throw err;
  }
  return file;
}

/* --------------------------------------------------------- manager routes */

/** An HTTP reply for a manager route: a status and a JSON body, `{ ok, … }` like every other route. */
export interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

/** The HTTP status for a failed CLI call, by its exit code: 2 usage, 3 unreachable, else rejected. */
function statusOf(code: number): number {
  return code === 2 ? 400 : code === 3 ? 502 : 500;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The fields of a UI's request a manager passes on: strings only, and `set` as KEY → text. */
function requestOf(body: Record<string, unknown>): InstallRequest {
  const req: InstallRequest = {};
  const id = text(body.id);
  const from = text(body.from);
  const source = text(body.source);
  const name = text(body.name);
  if (id !== undefined) req.id = id;
  if (from !== undefined) req.from = from;
  if (source !== undefined) req.source = source;
  if (name !== undefined) req.name = name;
  const set = body.set;
  if (set !== null && typeof set === "object" && !Array.isArray(set)) {
    req.set = Object.fromEntries(Object.entries(set).filter(([, v]) => typeof v === "string"));
  }
  if (body.noStart === true) req.noStart = true;
  return req;
}

/** A job as a page sees it: everything but the request, which the page sent. */
function view(job: InstallJob): Record<string, unknown> {
  const { request: _request, ...rest } = job;
  return rest;
}

/**
 * The marketplace and import routes of a manager tab, independent of how a
 * harness serves HTTP: each method takes what the route received and returns
 * the reply to send.
 *
 *   GET  /catalogue?search=&source=   the marketplace, each app marked compatible or not
 *   POST /inspect  { id | from, source? }        the inspect report
 *   POST /install  { id | from, source?, name?, set?, noStart? }   starts an install: { job }
 *   GET  /install?job=<id>            the job: each step's state, then the result
 *   POST /upload   <zip bytes>        saves a zip for --from: { file }
 *
 * A manager's own page installs without `noStart`, so the app is up when the
 * install ends and the page shows it in its app view. The folder is the CLI's
 * default (`$A2APP_HOME/apps/<name>`), and the CLI's opener is never asked:
 * the page is the display.
 */
export class PackageApi {
  readonly jobs: InstallJobs;

  constructor(private readonly frameworkBin: string) {
    this.jobs = new InstallJobs(frameworkBin);
  }

  async catalogue(query: { search?: unknown; source?: unknown }): Promise<ApiReply> {
    const r = await runA2App(this.frameworkBin, catalogueArgv(query));
    if (!r.ok || r.json === null) return { status: statusOf(r.code), body: { ok: false, message: failureOf(r), code: r.code } };
    return { status: 200, body: r.json as Record<string, unknown> };
  }

  async inspect(body: Record<string, unknown>): Promise<ApiReply> {
    const r = await runA2App(this.frameworkBin, inspectArgv(requestOf(body)));
    if (!r.ok || r.json === null) return { status: statusOf(r.code), body: { ok: false, message: failureOf(r), code: r.code } };
    return { status: 200, body: { ok: true, report: r.json } };
  }

  install(body: Record<string, unknown>): ApiReply {
    const request = requestOf(body);
    if (request.id === undefined && request.from === undefined) {
      return { status: 400, body: { ok: false, message: "Name a marketplace app or a source to install from." } };
    }
    // An upload is the manager's own file: once installed, it is no longer needed.
    const job = this.jobs.start(request, (done) => {
      if (done.ok && request.from !== undefined && isUpload(request.from) && existsSync(request.from)) rmSync(request.from, { force: true });
    });
    return { status: 200, body: { ok: true, job: view(job) } };
  }

  job(id: unknown): ApiReply {
    const job = typeof id === "string" ? this.jobs.get(id) : null;
    if (job === null) return { status: 404, body: { ok: false, message: "no such install — it may have ended over an hour ago" } };
    return { status: 200, body: { ok: true, job: view(job) } };
  }

  async upload(body: AsyncIterable<Uint8Array>, declaredLength?: number): Promise<ApiReply> {
    try {
      return { status: 200, body: { ok: true, file: await saveUpload(body, declaredLength) } };
    } catch (err) {
      if (err instanceof UploadTooLargeError) return { status: 413, body: { ok: false, message: err.message } };
      throw err;
    }
  }
}
