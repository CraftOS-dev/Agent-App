/**
 * The forwarding binding: an A2App surface whose operations are requests to
 * the adopted app's own endpoints.
 *
 * The binding maps each declared operation onto one upstream request — method,
 * path template, args as query string or JSON body — and turns every way that
 * request can fail into a machine-readable envelope. It never sees the caller:
 * by the time `runOperation` runs, adapter-core has already applied the origin,
 * credential, scope, guard and approval checks.
 */
import {
  createA2App,
  OperationError,
  type A2App,
  type A2AppConfig,
  type Binding,
  type EntityDef,
  type ListResult,
  type ModuleDecl,
  type OperationDecl,
  type ParamDef,
  type StoredRecord,
} from "@a2app/adapter-core";

export const REVERSE_PROXY_ADAPTER_VERSION = "0.1.0";

/** How long one forwarded call may take before it is abandoned. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * The largest upstream answer relayed. The same cap the adapter puts on a
 * request body: a protocol message is small, the result lands in an agent's
 * context, and buffering an unbounded answer would let the app behind the
 * adapter exhaust its memory.
 */
export const MAX_UPSTREAM_RESPONSE_BYTES = 5 * 1024 * 1024;

/** The HTTP methods an operation may be mapped onto. */
export const PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ProxyMethod = (typeof PROXY_METHODS)[number];

/** A `{name}` segment in a path template. */
export const PATH_PARAM = /\{([^{}]+)\}/g;

/** One declared operation mapped onto an upstream request. */
export interface ProxyOperation {
  name: string;
  description?: string;
  /** required: defaulting this to false would let a foreign mapping that forgot
   *  it bypass the approval gate on a destructive upstream call */
  destructive: boolean;
  readOnly?: boolean;
  idempotent?: boolean;
  /**
   * Which declared module this operation appears under. An adopted app has no
   * entities, so its walk is two levels — root, then module — and this is what
   * puts the operation on a screen at all.
   */
  module: string;
  /**
   * Typed parameters, in the protocol field vocabulary. Required for the same
   * reason as everywhere else: the module screen renders the signature, and a
   * mapping derived from a foreign route without one cannot be called correctly
   * on the first try.
   */
  params: Record<string, ParamDef>;
  /** upstream HTTP method + path template; `{arg}` segments are filled from args. */
  method: ProxyMethod;
  path: string;
  /** how the remaining args are sent. Default: `query` for GET (it has no
   *  body), `body` (JSON) for everything else. */
  send?: "body" | "query";
}

export interface ReverseProxyConfig {
  appId: string;
  appName?: string;
  /** `multi-user` gives the adopted app accounts and sign-in (spec/v0_2/auth.md);
   *  default `none`. */
  authMode?: "none" | "multi-user";
  upstreamBaseUrl: string;
  operations: ProxyOperation[];
  /**
   * The modules this adopted app is presented under. An app with no entities
   * still has a root screen, and its operations still need somewhere to live —
   * OpenAPI tags or route prefixes are the natural source when mapping one.
   */
  modules: ModuleDecl[];
  /** upstream auth header injected server-side, never handed to a caller. */
  upstreamHeaders?: Record<string, string>;
  /** per-call deadline; default {@link DEFAULT_UPSTREAM_TIMEOUT_MS}. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Everything else the served surface takes — credentials, the state store,
 *  origins, the public URL — exactly as `@a2app/adapter-core` defines it. */
export type ReverseProxyOptions = Omit<A2AppConfig, "modules" | "operations">;

/** How an operation's remaining args travel. */
export function sendOf(op: Pick<ProxyOperation, "method" | "send">): "body" | "query" {
  return op.send ?? (op.method === "GET" ? "query" : "body");
}

/**
 * The status an upstream refusal is relayed with. A 4xx is the caller's to fix
 * and keeps its status, except the authentication ones: those concern the
 * adapter's own access to the app, and relayed as they are they would read as
 * the A2App caller lacking a credential. Anything else is a gateway failure.
 */
function relayStatus(upstream: number): number {
  const authFailure = upstream === 401 || upstream === 403 || upstream === 407;
  return upstream >= 400 && upstream < 500 && !authFailure ? upstream : 502;
}

/** A thrown fetch failure, as the envelope the caller is owed. */
function transportFailure(e: unknown, timeoutMs: number): OperationError {
  if (e instanceof OperationError) return e;
  const err = e as { name?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError, during
  // the request or while the body is still arriving.
  if (err?.name === "TimeoutError") {
    return new OperationError("upstream_timeout", `The app did not answer within ${timeoutMs} ms.`, 504);
  }
  const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
  return new OperationError("upstream_unavailable", `The app behind this adapter is not answering (${String(cause)}).`, 503);
}

/** Read an upstream answer, refusing one past the cap. JSON when it parses,
 *  text otherwise, null when empty. */
async function readBounded(res: Response, limit: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body !== null) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new OperationError("upstream_response_too_large", `The app's answer exceeds the ${limit}-byte limit.`, 502, {
          limitBytes: limit,
        });
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Append args as a query string: repeated keys for a list, JSON for an object. */
function withQuery(target: string, args: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      qs.append(key, typeof item === "object" && item !== null ? JSON.stringify(item) : String(item));
    }
  }
  const query = qs.toString();
  return query === "" ? target : `${target}${target.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Fill a path template's `{arg}` segments. A value that would change WHICH
 * route is reached — empty, or a dot segment, which URL parsing resolves
 * (`/notes/..` is `/`) even when percent-encoded — is refused: a credential
 * holding one operation must not reach another of the app's routes through it.
 */
function fillPath(op: ProxyOperation, args: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
  const used = new Set<string>();
  const path = op.path.replace(PATH_PARAM, (_m, key: string) => {
    used.add(key);
    const value = args[key];
    const text = value === undefined || value === null ? "" : String(value);
    if (text === "" || text === "." || text === "..") {
      throw new OperationError(
        "invalid_argument",
        `"${key}" cannot be ${text === "" ? "empty" : `"${text}"`}: it is a segment of the app's own URL path.`,
        400,
        { field: key },
      );
    }
    return encodeURIComponent(text);
  });
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
  return { path, rest };
}

/** The Binding: no entities (operate-only), operations forwarded upstream. */
class ProxyBinding implements Binding {
  readonly appId: string;
  readonly appName: string | null;
  readonly adapterVersion = REVERSE_PROXY_ADAPTER_VERSION;
  readonly authMode: "none" | "multi-user";
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly opMap: Map<string, ProxyOperation>;
  private readonly doFetch: typeof fetch;

  constructor(cfg: ReverseProxyConfig) {
    this.appId = cfg.appId;
    this.appName = cfg.appName ?? null;
    this.authMode = cfg.authMode ?? "none";
    this.base = cfg.upstreamBaseUrl.replace(/\/+$/, "");
    this.headers = cfg.upstreamHeaders ?? {};
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.opMap = new Map(cfg.operations.map((o) => [o.name, o]));
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  entities(): Record<string, EntityDef> {
    return {}; // foreign data model is not mapped (proxy is ops-only)
  }
  listRecords(): ListResult {
    return { items: [] };
  }
  getRecord(): StoredRecord | null {
    return null;
  }
  createRecord(): never {
    throw new OperationError("unsupported", "This proxied app exposes operations, not record writes.", 405);
  }
  updateRecord(): never {
    throw new OperationError("unsupported", "This proxied app exposes operations, not record writes.", 405);
  }
  deleteRecord(): boolean {
    return false;
  }

  async runOperation(name: string, args: Record<string, unknown>): Promise<unknown> {
    const op = this.opMap.get(name);
    if (!op) throw new OperationError("unknown_operation", `No proxied operation "${name}".`, 404);

    // Path segments first; the rest go to the query string or the JSON body.
    const { path, rest } = fillPath(op, args);
    let url = this.base + path;
    // Only what the mapping declares travels: the caller's own headers — its
    // A2App credential above all — never reach the app behind the adapter.
    const headers: Record<string, string> = { accept: "application/json", ...this.headers };
    const init: RequestInit = { method: op.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (sendOf(op) === "query") {
      url = withQuery(url, rest);
    } else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(rest);
    }

    let status: number;
    let statusText: string;
    let payload: unknown;
    try {
      const res = await this.doFetch(url, init);
      status = res.status;
      statusText = res.statusText;
      payload = await readBounded(res, MAX_UPSTREAM_RESPONSE_BYTES);
    } catch (e) {
      throw transportFailure(e, this.timeoutMs);
    }
    if (status >= 400) {
      throw new OperationError("upstream_error", `The app answered ${status}${statusText ? ` ${statusText}` : ""}.`, relayStatus(status), {
        upstreamStatus: status,
        upstream: payload,
      });
    }
    return payload;
  }
}

export function operationDecls(cfg: Pick<ReverseProxyConfig, "operations">): OperationDecl[] {
  return cfg.operations.map((o) => ({
    name: o.name,
    destructive: o.destructive,
    module: o.module,
    params: o.params,
    ...(o.description ? { description: o.description } : {}),
    ...(o.readOnly ? { readOnly: true } : {}),
    ...(o.idempotent ? { idempotent: true } : {}),
  }));
}

/** Build an A2App surface that proxies a foreign app.
 *
 *  An adopted app publishes operations and no entities, so its walk stops at the
 *  module level: root lists the modules, each module lists its operations, and
 *  there is no entity or record screen to descend into. The walk never assumes
 *  entities exist (A2APP-SPEC 3.6). */
export function createReverseProxy(cfg: ReverseProxyConfig, options: ReverseProxyOptions = {}): A2App {
  return createA2App(new ProxyBinding(cfg), { ...options, modules: cfg.modules, operations: operationDecls(cfg) });
}
