/**
 * @a2app/reverse-proxy — the sidecar adapter form, for foreign codebases whose
 * stack cannot host an in-process adapter.
 *
 * It reads a declarative mapping and serves the A2App surface in front of the
 * app, forwarding declared operations to the upstream's own endpoints. Foreign
 * apps are OPERATE-ONLY: the data model is not mapped, so `describe` reports
 * `entities: {}` by design and operations are the only guarded surface.
 * Everything else — identity, the error envelope, approval for destructive ops,
 * IAM, the origin/credential/scope chain — is shared verbatim from
 * `@a2app/adapter-core`.
 */
import {
  createA2App,
  createA2AppServer,
  OperationError,
  type A2App,
  type Binding,
  type EntityDef,
  type Grant,
  type ListResult,
  type OperationDecl,
  type StoredRecord,
  type ParamDef,
} from "@a2app/adapter-core";

export const REVERSE_PROXY_ADAPTER_VERSION = "0.1.0";

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
  method: string;
  path: string;
  /** how remaining args are sent: as a JSON body (default) or query string. */
  send?: "body" | "query";
}

export interface ReverseProxyConfig {
  appId: string;
  appName?: string;
  upstreamBaseUrl: string;
  operations: ProxyOperation[];
  /**
   * The modules this adopted app is presented under. An app with no entities
   * still has a root screen, and its operations still need somewhere to live —
   * OpenAPI tags or route prefixes are the natural source when mapping one.
   */
  modules: { name: string; summary?: string }[];
  /** conventions text surfaced in describe. */
  conventions?: Record<string, unknown>;
  /** upstream auth header injected server-side, never handed to a caller. */
  upstreamHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** The Binding: no entities (operate-only), operations forwarded upstream. */
class ProxyBinding implements Binding {
  readonly appId: string;
  readonly appName: string | null;
  readonly adapterVersion = REVERSE_PROXY_ADAPTER_VERSION;
  readonly authMode = "none" as const;
  private readonly cfg: ReverseProxyConfig;
  private readonly opMap: Map<string, ProxyOperation>;
  private readonly doFetch: typeof fetch;

  constructor(cfg: ReverseProxyConfig) {
    this.cfg = cfg;
    this.appId = cfg.appId;
    this.appName = cfg.appName ?? null;
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

    // Fill {arg} path segments; the rest go to body or query.
    const used = new Set<string>();
    const path = op.path.replace(/\{([^}]+)\}/g, (_m, key: string) => {
      used.add(key);
      return encodeURIComponent(String(args[key] ?? ""));
    });
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;

    let url = this.cfg.upstreamBaseUrl.replace(/\/$/, "") + path;
    const init: RequestInit = {
      method: op.method,
      headers: { "content-type": "application/json", ...(this.cfg.upstreamHeaders ?? {}) },
    };
    if (op.send === "query") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(rest)) qs.set(k, String(v));
      if (qs.size) url += (url.includes("?") ? "&" : "?") + qs.toString();
    } else if (op.method !== "GET" && op.method !== "HEAD") {
      init.body = JSON.stringify(rest);
    }

    const res = await this.doFetch(url, init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    if (res.status >= 300) {
      throw new OperationError("upstream_error", `Upstream returned ${res.status}.`, res.status, { upstream: json });
    }
    return json;
  }
}

export function operationDecls(cfg: ReverseProxyConfig): OperationDecl[] {
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
export function createReverseProxy(cfg: ReverseProxyConfig, credentials: Grant[]): A2App {
  return createA2App(new ProxyBinding(cfg), {
    credentials,
    modules: cfg.modules,
    operations: operationDecls(cfg),
    ...(cfg.conventions ? { conventions: cfg.conventions } : {}),
  });
}

/** Run the proxy as a standalone sidecar server. */
export function startReverseProxy(cfg: ReverseProxyConfig, port: number, token: string): ReturnType<typeof createA2AppServer> {
  const grant: Grant = { token, credentialId: "cred_proxy", agentName: "local", principal: "owner", scopes: ["*"] };
  const server = createA2AppServer(createReverseProxy(cfg, [grant]));
  // Loopback explicitly: `listen(port)` alone binds every interface, which this
  // line already claimed it did not. A sidecar carrying an owner-scoped grant
  // must not be the thing that puts the app on the network.
  server.listen(port, "127.0.0.1", () => process.stdout.write(`reverse-proxy adapter for ${cfg.appId} on http://127.0.0.1:${port}\n`));
  return server;
}
