/**
 * A2AppClient — a thin, dependency-free HTTP client for the A2App protocol. It
 * speaks the public surface any agent can speak; it holds no privileged access.
 * The CLI is one consumer; an agent harness is another.
 *
 * Every method returns the app's response verbatim (status + parsed JSON) so the
 * caller can branch on `code`, never on prose.
 */
import { ACCEPTED_PROTOCOLS, type Context, type Describe, type Identity, type Task, type Whoami, type A2AppEvent } from "./types.js";

/** Raised when the app is unreachable (CLI exit 3). Network failure, not a
 *  protocol rejection. */
export class A2AppUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "A2AppUnreachableError";
  }
}

/** Raised when a response body exceeds the client's size cap. A protocol reply
 *  is always small; a multi-megabyte body is a hostile or runaway app, and
 *  reading it whole would OOM the agent. */
export class ResponseTooLargeError extends Error {
  constructor(readonly received: number, readonly limit: number) {
    super(`Response body exceeds the ${limit}-byte cap (saw at least ${received} bytes) — refusing to buffer it.`);
    this.name = "ResponseTooLargeError";
  }
}

export interface A2AppResponse {
  status: number;
  body: string;
  json: unknown;
  ok: boolean;
}

export interface A2AppClientOptions {
  /** e.g. http://127.0.0.1:8090 */
  baseUrl: string;
  /** the agent credential, sent as X-A2App-Token on program writes */
  token?: string | null;
  /** self-declared agent name recorded in the audit log (X-A2App-Agent) */
  agentName?: string;
  /** the acting user's own auth token, for operation calls on multi-user apps */
  authToken?: string | null;
  /** per-request timeout in ms (default 15000). A black-hole port would otherwise
   *  hang an operate command forever; on timeout the request aborts and throws
   *  {@link A2AppUnreachableError} (CLI exit 3). Pass 0 to disable. */
  timeoutMs?: number;
  /** max bytes read from a response body before erroring (default 10 MiB). Guards
   *  the agent against a hostile or runaway app streaming an unbounded body. */
  maxResponseBytes?: number;
}

/** Default per-request timeout: long enough for a slow-but-alive local backend,
 *  short enough that a dead port fails fast instead of hanging the agent. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default response body cap (10 MiB). */
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Unwrap Node's fetch error chain into one true sentence. A bare
 * "TypeError: fetch failed" hides ECONNREFUSED in a nested `cause`, and an agent
 * that reads only the surface will conclude the network is down when its own
 * app is simply not running.
 */
export function describeFetchError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AggregateError) {
      for (const sub of current.errors) {
        const msg = sub instanceof Error ? sub.message : String(sub);
        if (msg) parts.push(msg);
      }
      current = undefined;
    } else if (current instanceof Error) {
      if (current.message) parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  let message = parts.join(" — caused by: ");
  if (/ECONNREFUSED|ECONNRESET/.test(message)) {
    message +=
      "\nThe app is NOT RUNNING (connection refused is a dead local server, not a network problem). Launch it, then retry.";
  } else if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    message += "\nDNS lookup failed for the target host — check the hostname.";
  } else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(message)) {
    message += "\nThe target did not answer in time — it may be down or unreachable.";
  }
  return message || String(err);
}

export class A2AppClient {
  readonly baseUrl: string;
  private token: string | null;
  private agentName: string;
  private authToken: string | null;
  private timeoutMs: number;
  private maxResponseBytes: number;

  constructor(opts: A2AppClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token ?? null;
    this.agentName = opts.agentName ?? "a2app-sdk";
    this.authToken = opts.authToken ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** Low-level request. Throws {@link A2AppUnreachableError} on network failure;
   *  otherwise resolves with the response even on 4xx/5xx (a rejection is a
   *  normal outcome, not an exception). */
  async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<A2AppResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-A2App-Agent": this.agentName,
    };
    if (this.token !== null) headers["X-A2App-Token"] = this.token;
    if (this.authToken !== null) headers["Authorization"] = this.authToken;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    // Per-request timeout: without it a bare fetch to a black-hole port hangs
    // forever. On timeout we abort and route through describeFetchError's
    // ETIMEDOUT branch so the CLI maps it to "unreachable" (exit 3).
    const controller = new AbortController();
    let timedOut = false;
    const timer =
      this.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.timeoutMs)
        : null;
    init.signal = controller.signal;

    let res: globalThis.Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      if (timedOut) {
        const note = describeFetchError(
          new Error(`ETIMEDOUT: no response from ${this.baseUrl}${path} within ${this.timeoutMs}ms`),
        );
        throw new A2AppUnreachableError(note, { cause: err });
      }
      throw new A2AppUnreachableError(describeFetchError(err), { cause: err });
    } finally {
      if (timer) clearTimeout(timer);
    }

    let text: string;
    try {
      text = await this.readCappedBody(res);
    } catch (err) {
      if (err instanceof ResponseTooLargeError) throw err;
      // A body that errors mid-stream (connection dropped) is an unreachable-class
      // failure, not a protocol rejection.
      throw new A2AppUnreachableError(describeFetchError(err), { cause: err });
    }
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: text, json, ok: res.status < 300 };
  }

  /** Read a response body but refuse more than `maxResponseBytes`, so a hostile
   *  or runaway app cannot OOM the agent with an unbounded stream. Checks the
   *  advertised Content-Length first, then enforces the cap byte-by-byte while
   *  reading (a lying or absent header cannot get past the streamed count). */
  private async readCappedBody(res: globalThis.Response): Promise<string> {
    const max = this.maxResponseBytes;
    if (max <= 0) return res.text();
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) {
      throw new ResponseTooLargeError(declared, max);
    }
    const body = res.body;
    if (!body) return res.text();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > max) {
            await reader.cancel();
            throw new ResponseTooLargeError(total, max);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    let offset = 0;
    const joined = new Uint8Array(total);
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(joined);
  }

  /* ------------------------------------------------------------- discovery */

  /** Probe an app's identity. Tries the well-known path first, then the API
   *  alias. Returns null when the marker `a2app: true` is absent. */
  async identity(): Promise<Identity | null> {
    for (const path of ["/.well-known/a2app.json", "/api/_a2app"]) {
      const res = await this.request("GET", path);
      const id = res.json as Identity | null;
      if (id && id.a2app === true) return id;
    }
    return null;
  }

  /** True when the app speaks a protocol major this client understands. */
  static protocolSupported(protocol: string): boolean {
    return (ACCEPTED_PROTOCOLS as readonly string[]).includes(protocol);
  }

  async describe(): Promise<Describe | null> {
    const res = await this.request("GET", "/api/_a2app/describe");
    if (!res.ok) return null;
    return res.json as Describe;
  }

  async whoami(): Promise<Whoami | null> {
    const res = await this.request("GET", "/api/_a2app/whoami");
    if (!res.ok) return null;
    return res.json as Whoami;
  }

  async context(): Promise<Context | null> {
    const res = await this.request("GET", "/api/_a2app/context");
    if (!res.ok) return null;
    return res.json as Context;
  }

  /* ------------------------------------------------------------------ data */

  private recordsPath(entity: string): string {
    return `/api/collections/${entity}/records`;
  }

  listRecords(
    entity: string,
    query?: { filter?: string; sort?: string; perPage?: number },
  ): Promise<A2AppResponse> {
    const qs = new URLSearchParams();
    if (query?.filter) qs.set("filter", query.filter);
    if (query?.sort) qs.set("sort", query.sort);
    if (query?.perPage) qs.set("perPage", String(query.perPage));
    const suffix = qs.size ? `?${qs}` : "";
    return this.request("GET", `${this.recordsPath(entity)}${suffix}`);
  }

  getRecord(entity: string, id: string): Promise<A2AppResponse> {
    return this.request("GET", `${this.recordsPath(entity)}/${id}`);
  }

  createRecord(
    entity: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<A2AppResponse> {
    return this.request("POST", this.recordsPath(entity), body, idem(idempotencyKey));
  }

  updateRecord(
    entity: string,
    id: string,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<A2AppResponse> {
    return this.request("PATCH", `${this.recordsPath(entity)}/${id}`, body, idem(idempotencyKey));
  }

  deleteRecord(entity: string, id: string): Promise<A2AppResponse> {
    return this.request("DELETE", `${this.recordsPath(entity)}/${id}`);
  }

  /* ------------------------------------------------------------ operations */

  /** Invoke a declared operation. Pass `approvalKey` to execute a destructive op
   *  that previously returned `approval_required`. */
  callOperation(
    name: string,
    args?: Record<string, unknown>,
    approvalKey?: string,
  ): Promise<A2AppResponse> {
    const headers = approvalKey ? { "X-A2App-Approval": approvalKey } : undefined;
    return this.request("POST", `/api/ops/${name}`, args ?? {}, headers);
  }

  /* ------------------------------------------------------------ app→agent */

  pollEvents(since?: string): Promise<A2AppResponse> {
    const suffix = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request("GET", `/api/_a2app/events${suffix}`);
  }

  pollTasks(status = "submitted"): Promise<A2AppResponse> {
    return this.request("GET", `/api/_a2app/tasks?status=${encodeURIComponent(status)}`);
  }

  getTask(id: string): Promise<A2AppResponse> {
    return this.request("GET", `/api/_a2app/tasks/${id}`);
  }

  claimTask(id: string, credentialId: string): Promise<A2AppResponse> {
    return this.request("POST", `/api/_a2app/tasks/${id}/claim`, { agent: credentialId });
  }

  progressTask(id: string, progress: { step?: string; percent?: number; ask?: unknown }): Promise<A2AppResponse> {
    return this.request("POST", `/api/_a2app/tasks/${id}/progress`, progress);
  }

  completeTask(
    id: string,
    result: { status: "completed"; result?: Record<string, unknown> } | { status: "failed"; reason: string },
  ): Promise<A2AppResponse> {
    return this.request("POST", `/api/_a2app/tasks/${id}/complete`, result);
  }

  cancelTask(id: string): Promise<A2AppResponse> {
    return this.request("POST", `/api/_a2app/tasks/${id}/cancel`, {});
  }
}

function idem(key: string | undefined): Record<string, string> | undefined {
  return key === undefined ? undefined : { "Idempotency-Key": key };
}

export type { Identity, Describe, Whoami, Context, Task, A2AppEvent };
