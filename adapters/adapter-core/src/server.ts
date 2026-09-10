/**
 * The A2App served surface (front face) — stack-agnostic and identical across
 * every adapter. Given a {@link Binding} it serves identity, describe, guarded
 * records CRUD, declared operations (with approval), the app→agent task/event
 * plane, context, whoami, and the IAM checks — enforcing the fixed validation
 * chain: origin → credential → scope → guard → backend → read-back.
 */
import {
  validate,
  divergences,
  describeViolation,
  describeIncomplete,
  labelFieldOf,
  schemaFingerprint,
  ERROR_CODES,
  type EntityPrint,
  type NormalizedField,
  type Violation,
} from "@a2app/rules";
import {
  buildEntity,
  buildFind,
  buildModule,
  buildRecord,
  buildRelation,
  buildRoot,
  modelProblems,
  FULL_ACCESS,
  NO_ACCESS,
  type Access,
  type DescribeDeps,
} from "./describe.js";
import { approvalKey, canonicalize, sha256Prefixed } from "./canon.js";
import { FileStateStore, InMemoryStateStore, knownEventTypes, type StateStore, type StoredTask } from "./store.js";
import { RateLimiter, DEFAULT_RATE_LIMITS, type RouteClass } from "./rate.js";
import {
  OperationError,
  UnsupportedFilterError,
  type A2AppConfig,
  type A2AppReply,
  type A2AppRequest,
  type AuditEntry,
  type Binding,
  type CallContext,
  type Grant,
  type OperationDecl,
} from "./types.js";

export const ADAPTER_CORE_VERSION = "0.1.0";
const PROTOCOL_VERSION = "0.1";

/**
 * The default answer to "how do I get a credential?", attached to every 401.
 *
 * Both challenges send the same text because they are the same question, and a
 * caller that met one and then the other should not have to learn the answer
 * twice. An app serving anyone but its owner sets `credentialHint` instead: this
 * default describes a file on the host, which is an answer only its owner can act
 * on.
 */
const DEFAULT_CREDENTIAL_HINT = "Read the app's .agent-token file (mode 0600) in the project directory.";
const TASK_TIMEOUT_MS = 60_000;
const TASK_MAX_DELIVERIES = 5;
const DESCRIBE_PREFIX = "/api/_a2app/describe/";

export interface A2App {
  /** Route a request. Resolves to a reply, or null if the path is not an A2App
   *  path (the host app then handles it with its own routes). */
  handle(req: A2AppRequest): Promise<A2AppReply | null>;
  /** The identity document. */
  identity(): Record<string, unknown>;
  /** Emit a typed event and, if `capability` is given, enqueue a task for the
   *  agent. The app calls this; the agent polls. */
  trigger(input: {
    type: string;
    payload: Record<string, unknown>;
    capability?: string;
    dedupKey?: string;
  }): { eventId: string; taskId: string | null };
  readonly store: StateStore;
}

/**
 * Build the served surface for one app.
 *
 * `config` has no default: an app must declare its modules, and there is no
 * sensible empty configuration — an adapter with no modules has no root screen
 * and cannot be walked. Making the parameter required turns that into a compile
 * error at every call site rather than a throw at boot.
 */
export function createA2App(binding: Binding, config: A2AppConfig): A2App {
  const now = config.now ?? (() => new Date());
  // Durability by default: an explicit store wins; otherwise a supplied storePath
  // gives a restart-durable FileStateStore (the conforming posture — an in-memory
  // idempotency table is lost on the very restart a retry rides in on); only with
  // neither do we fall back to the fast in-memory store (tests, ephemeral apps).
  const store: StateStore =
    config.store ??
    (config.storePath
      ? new FileStateStore(config.storePath, binding.appId, () => now().getTime())
      : new InMemoryStateStore(binding.appId, () => now().getTime()));
  const operations = config.operations ?? [];
  const opByName = new Map(operations.map((o) => [o.name, o]));
  const eventTypes = knownEventTypes(config.events);
  const allowedOrigins = new Set(config.allowedOrigins ?? []);
  // Host names this app will answer to. Derived from the origins it already
  // declares, so an app that configures its own UI origin keeps working.
  const allowedHosts = new Set((config.allowedHosts ?? []).map((h) => h.toLowerCase()));
  for (const origin of config.allowedOrigins ?? []) {
    try {
      allowedHosts.add(new URL(origin).host.toLowerCase());
    } catch {
      /* not a URL - ignore */
    }
  }
  const audit = config.audit ?? ((e: AuditEntry) => store.appendAudit(e));
  const limiter = new RateLimiter({ ...DEFAULT_RATE_LIMITS, ...(config.rateLimits ?? {}) }, () => now().getTime());

  // Seed grants (the platform issues the default local grant at launch).
  for (const g of config.credentials ?? []) store.putGrant(g);

  /* ------------------------------------------- data version + viewers */

  /**
   * `dataVersion` — the marker that moves when RECORDS change.
   *
   * A loaded page has two different reasons to be wrong, and until now identity
   * published a marker for only one of them. `appVersion` fingerprints the View
   * bytes and `schemaVersion` the model, so BOTH are byte-identical after an
   * agent creates a record — which is exactly when every open tab is showing a
   * list that no longer matches the database. A watcher polling those two can
   * not distinguish "nothing happened" from "everything changed", so it reported
   * nothing.
   *
   * Kept deliberately separate from the other two rather than folded in, because
   * the right response differs: a code change means the page must be REPLACED,
   * while a data change means it must RE-READ. Collapsing them would force a
   * reload — and the loss of whatever is half-typed — for the common case of
   * someone else adding a row.
   *
   * The boot component makes a restart count as a change: a server that came
   * back up may have been migrated or restored under a page that is still
   * holding rows from before, and re-reading is the cheap, always-correct answer.
   */
  const bootMark = now().getTime().toString(36);
  let dataWrites = 0;
  const dataVersion = (): string => `${bootMark}.${dataWrites}`;
  const markDataChanged = (): void => {
    dataWrites++;
  };

  /**
   * Connected viewers, by the opaque per-tab id their update watcher sends.
   *
   * This exists to answer one local question — "is anyone actually looking at
   * this app, or should the CLI open a browser?" — without which every update
   * either opens a duplicate tab or reaches nobody.
   *
   * It records a COUNT and never identities: in a multi-user deployment "who is
   * looking at this right now" is a different, more sensitive question than "is
   * anyone", and only the second one is needed here. The ids are opaque, held in
   * memory only, and never published.
   */
  const VIEWER_TTL_MS = 60_000;
  const VIEWER_CAP = 1_000;
  const viewers = new Map<string, number>();

  /** Record a heartbeat, if this request carried one. The watcher rides its
   *  existing identity poll rather than adding a request of its own. */
  function noteViewer(req: A2AppRequest): void {
    // Header on the ordinary poll; query string for the goodbye, because that is
    // sent with `navigator.sendBeacon` — the only request a closing page can
    // rely on delivering, and one that cannot carry custom headers.
    const id = req.headers["x-a2app-viewer"] ?? req.query["viewer"];
    if (typeof id !== "string" || id === "" || id.length > 64) return;
    // A closing tab says goodbye on its way out, so the count drops at once
    // rather than at the end of the TTL. Without it, closing the last tab leaves
    // up to a minute in which `open --if-needed` believes someone is still
    // watching and silently declines to open anything.
    if (req.headers["x-a2app-viewer-leaving"] !== undefined || req.query["leaving"] !== undefined) {
      viewers.delete(id);
      return;
    }
    viewers.set(id, now().getTime());
    // A page that reloads gets a fresh id, so the map would otherwise grow with
    // every reload of every tab until the process restarts.
    if (viewers.size > VIEWER_CAP) countViewers();
  }

  /** Live viewers, pruning the expired as it goes. */
  function countViewers(): number {
    const cutoff = now().getTime() - VIEWER_TTL_MS;
    let live = 0;
    for (const [id, seen] of viewers) {
      if (seen < cutoff) viewers.delete(id);
      else live++;
    }
    return live;
  }

  // Fail fast on an inconsistent app part. A model whose entities or operations
  // name a module that was never declared cannot be walked — the entity would
  // sit under no screen and the operation would be unreachable — so refusing at
  // construction is the only honest outcome. Serving it would mean a describe
  // that omits real capability while answering 200.
  {
    const problems = modelProblems({ binding, operations, modules: config.modules, conventions });
    if (problems.length > 0) {
      throw new Error(
        `A2App adapter: the app's declarations are inconsistent and cannot be served:\n  - ${problems.join("\n  - ")}`,
      );
    }
  }

  /* --------------------------------------------------------- envelopes */

  function ok(json: unknown, status = 200, headers?: Record<string, string>): A2AppReply {
    return headers ? { status, json, headers } : { status, json };
  }
  function err(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): A2AppReply {
    return { status, json: { a2app: true, ok: false, code, message, ...extra } };
  }
  function guardEnvelope(violations: Violation[], serverNow: string): A2AppReply {
    const first = violations[0]!;
    return {
      status: 400,
      json: {
        a2app: true,
        ok: false,
        code: first.code,
        field: first.field,
        expected: first.expected,
        got: first.got,
        message: describeViolation(first, serverNow),
        violations: violations.map((v) => ({
          code: v.code,
          field: v.field,
          expected: v.expected,
          got: v.got,
        })),
      },
    };
  }

  /** Rate gate. Keyed by credential token (or same-origin UI / anonymous). Over
   *  the limit answers 429 `rate_limited` before any work. */
  function rateGate(req: A2AppRequest, cls: RouteClass): A2AppReply | null {
    const caller = req.headers["x-a2app-token"] ?? req.headers["x-lui-token"] ?? (req.headers["origin"] ? "origin:" + req.headers["origin"] : "anon");
    const decision = limiter.check(caller, cls);
    if (decision.allowed) return null;
    // A rate-limit refusal happens before credential resolution, but it must stay
    // traceable — record the caller key (token/origin/anon) and route class in the
    // bounded audit ring so a flood is visible after the fact.
    writeAudit({ credentialId: caller, agentName: null, principal: null }, `rate:${cls}`, null, "rejected", ERROR_CODES.RATE_LIMITED);
    return err(429, ERROR_CODES.RATE_LIMITED, `Rate limit exceeded (${decision.limit} per window). Slow down and retry.`, {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  /* ------------------------------------------------------------ schema */

  function entityPrints(): Record<string, EntityPrint> {
    const defs = binding.entities();
    const out: Record<string, EntityPrint> = {};
    for (const [name, def] of Object.entries(defs)) {
      out[name] = { fields: def.fields, ...(def.auth ? { auth: true } : {}), module: def.module };
    }
    return out;
  }

  function schemaVersion(): string {
    return schemaFingerprint(entityPrints(), operations);
  }

  const describeDeps: DescribeDeps = {
    binding,
    operations,
    modules: config.modules,
    conventions,
  };

  /**
   * Serve one level of describe (A2APP-SPEC 3).
   *
   * `segments` is the path after `/api/_a2app/describe`, already decoded. Depth
   * selects the level: none → root, module, module/entity, module/entity/id,
   * module/entity/id/relation. `?find=` short-circuits to search.
   *
   * The record and relation levels read real records, which makes them data
   * reads: they take the same `data:{entity}:read` scope and the same rate class
   * as the records API. Without that, describe would be an unauthenticated,
   * unmetered path around the entire scope model — the shallower levels can stay
   * open because they publish only shape, never values.
   */
  async function handleDescribe(req: A2AppRequest, segments: string[]): Promise<A2AppReply> {
    const access = accessFor(req);

    const find = req.query["find"];
    if (find !== undefined && segments.length === 0) {
      if (find === "") return err(400, "usage", "find needs a term: describe?find={term}");
      return ok(buildFind(describeDeps, find, access));
    }

    if (segments.length === 0) return ok(buildRoot(describeDeps, access, { all: req.query["all"] === "true" }));

    const [moduleName, entityName, recordId, relationName] = segments;
    const module = describeDeps.modules.find((m) => m.name === moduleName);
    if (!module) {
      return err(404, "unknown_module", `No module "${moduleName}".`, {
        modules: describeDeps.modules.map((m) => m.name),
      });
    }
    if (entityName === undefined) {
      return ok(buildModule(describeDeps, module, access, { all: req.query["all"] === "true" }));
    }

    const defs = binding.entities();
    const def = defs[entityName];
    if (!def) return err(404, "unknown_entity", `No such entity "${entityName}".`);
    if (def.module !== moduleName) {
      return err(404, "unknown_entity", `Entity "${entityName}" is in module "${def.module}", not "${moduleName}".`);
    }

    if (recordId === undefined) {
      if (!access.canRead(entityName)) {
        return err(403, ERROR_CODES.INSUFFICIENT_SCOPE, `This credential does not hold data:${entityName}:read.`, {
          required: `data:${entityName}:read`,
        });
      }
      return ok(buildEntity(describeDeps, moduleName!, entityName, def, access, { all: req.query["all"] === "true" }));
    }

    // From here the level reads stored records — authorize and meter as a read.
    const limited = rateGate(req, "data");
    if (limited) return limited;
    const authz = authorize(req, { scope: `data:${entityName}:read`, isWrite: false });
    if ("reply" in authz) return authz.reply;

    const record = await binding.getRecord(entityName, recordId);
    if (!record) return err(404, "record_not_found", `No ${entityName} record "${recordId}".`);

    if (relationName === undefined) {
      return ok(buildRecord(describeDeps, moduleName!, entityName, def, record, access));
    }

    const relationField = def.fields.find(
      (f) => f.name === relationName && f.type === "list<ref>" && f.entity !== undefined && !f.writeOnly,
    );
    if (!relationField?.entity) {
      return err(404, "unknown_relation", `"${relationName}" is not a sub-resource of ${entityName}.`, {
        relations: def.fields.filter((f) => f.type === "list<ref>" && !f.writeOnly).map((f) => f.name),
      });
    }
    const target = relationField.entity;
    if (!access.canRead(target)) {
      return err(403, ERROR_CODES.INSUFFICIENT_SCOPE, `This credential does not hold data:${target}:read.`, {
        required: `data:${target}:read`,
      });
    }
    const targetDef = defs[target];
    const targetLabel = targetDef ? labelFieldOf(targetDef.fields) : null;
    const ids = record[relationName];
    const rows: { id: string; label: string | null }[] = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const referenced = await binding.getRecord(target, String(id));
      // A dangling reference is reported as the id it is, not dropped: silently
      // shortening the list would hide a broken relation behind a shorter one.
      const label = referenced && targetLabel !== null ? referenced[targetLabel] : null;
      rows.push({ id: String(id), label: typeof label === "string" ? label : label == null ? null : String(label) });
    }
    return ok(buildRelation(moduleName!, entityName, recordId, relationName, target, rows));
  }

  function conventions(): Record<string, unknown> {
    return {
      writes: "Prefer a declared operation over a raw write where one exists.",
      labels:
        "Resolve a label to an id by a filtered read on the entity's label field; on multi-match, ask or fail — never pick.",
      dates: "Relative words (\"tomorrow\") are rejected by the app; resolve them to ISO 8601 client-side.",
      honesty:
        "If the app cannot express what was asked, say so instead of approximating into a wrong field.",
      ...(config.conventions ?? {}),
    };
  }

  /* --------------------------------------------------------- identity */

  function identityDoc(): Record<string, unknown> {
    const d = now();
    const doc: Record<string, unknown> = {
      a2app: true,
      protocol: PROTOCOL_VERSION,
      adapterVersion: binding.adapterVersion,
      app: { id: binding.appId, name: binding.appName },
      schemaVersion: schemaVersion(),
      // Moves on every record write. A View watcher compares this separately
      // from appVersion/schemaVersion so it can re-read data without reloading.
      dataVersion: dataVersion(),
      serverNow: d.toISOString(),
      serverTzOffsetMinutes: -d.getTimezoneOffset(),
    };
    if (config.env) doc.env = config.env;
    // Published only when the app actually has one: a field that is sometimes an
    // empty string would make a client's "did it change?" comparison lie the
    // first time the app could not compute it.
    const appVersion = typeof config.appVersion === "function" ? config.appVersion() : config.appVersion;
    if (typeof appVersion === "string" && appVersion !== "") doc.appVersion = appVersion;
    return doc;
  }

  /* --------------------------------------------------------- IAM helpers */

  function expandScopes(grant: Grant): Set<string> {
    if (!grant.scopes.includes("*")) return new Set(grant.scopes);
    const scopes = new Set<string>();
    for (const name of Object.keys(binding.entities())) {
      scopes.add(`data:${name}:read`);
      scopes.add(`data:${name}:write`);
    }
    for (const o of operations) scopes.add(`op:${o.name}`);
    return scopes;
  }

  function credentialOf(req: A2AppRequest): Grant | null {
    const token = req.headers["x-a2app-token"] ?? req.headers["x-lui-token"];
    if (!token) return null;
    return store.grantByToken(token);
  }

  /**
   * Is this request addressed to the loopback interface by name?
   *
   * Binding to 127.0.0.1 does not stop a browser reaching the app: an attacker
   * page on evil.com whose DNS re-resolves to 127.0.0.1 is then *same-origin*
   * with this server as far as the browser is concerned, so it sends no Origin
   * on a GET and can read every response. The origin rule cannot catch that —
   * there is no origin to judge. The Host header can: a rebound request still
   * carries `evil.com`, because that is the name the page was fetched from.
   */
  function isAllowedHost(raw: string): boolean {
    const host = raw.toLowerCase();
    if (allowedHosts.has(host)) return true;
    // Strip the port; an IPv6 literal is bracketed, so scan past the bracket.
    const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
    if (name === "localhost" || name === "[::1]" || name === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
  }

  function isForeignOrigin(req: A2AppRequest): boolean {
    const origin = req.headers["origin"];
    if (origin === undefined) return false; // a program, not a browser
    return !allowedOrigins.has(origin);
  }

  function isSameOrigin(req: A2AppRequest): boolean {
    const origin = req.headers["origin"];
    return origin !== undefined && allowedOrigins.has(origin);
  }

  /** The fixed chain: origin → credential → scope. Returns the call context on
   *  success, or the refusal reply. */
  function authorize(
    req: A2AppRequest,
    opts: { scope: string | null; isWrite: boolean },
  ): { ctx: CallContext } | { reply: A2AppReply } {
    // 1. origin — a foreign browser origin is refused before anything else.
    if (isForeignOrigin(req)) {
      return { reply: err(403, "forbidden_origin", "Refused: request Origin is not this app's own.") };
    }
    // The app's own UI (same origin) is trusted: no credential needed.
    if (isSameOrigin(req)) {
      return { ctx: { credentialId: "ui", agentName: null, principal: "owner" } };
    }
    // 2. credential — a program write always needs one; a read needs one on a
    //    multi-user app, and is scope-checked whenever a token is presented.
    const grant = credentialOf(req);
    const credentialRequired = opts.isWrite || binding.authMode === "multi-user";
    if (!grant) {
      if (credentialRequired) {
        return {
          reply: err(401, ERROR_CODES.AGENT_TOKEN_REQUIRED, "This write requires an agent credential.", {
            how: config.credentialHint ?? DEFAULT_CREDENTIAL_HINT,
          }),
        };
      }
      return { ctx: { credentialId: "anonymous", agentName: null, principal: "owner" } };
    }
    // 3. scope
    if (opts.scope) {
      const held = expandScopes(grant);
      if (!held.has(opts.scope)) {
        return {
          reply: err(403, ERROR_CODES.INSUFFICIENT_SCOPE, `This credential does not hold ${opts.scope}.`, {
            required: opts.scope,
          }),
        };
      }
    }
    return { ctx: { credentialId: grant.credentialId, agentName: grant.agentName, principal: grant.principal } };
  }

  /**
   * What this caller may do, for rendering access on a describe level.
   *
   * Mirrors {@link authorize}'s own precedence exactly, including its two
   * bypasses: the app's own UI and an anonymous read on a single-user app both
   * reach a context without ever meeting the scope check, so both genuinely have
   * full access and must be shown as such. Deriving this separately from the
   * scope set alone would tell those callers they cannot reach modules they can.
   */
  function accessFor(req: A2AppRequest): Access {
    if (isSameOrigin(req)) return FULL_ACCESS;
    const grant = credentialOf(req);
    if (!grant) return binding.authMode === "multi-user" ? NO_ACCESS : FULL_ACCESS;
    const held = expandScopes(grant);
    return {
      canRead: (entity) => held.has(`data:${entity}:read`),
      canWrite: (entity) => held.has(`data:${entity}:write`),
      canRun: (operation) => held.has(`op:${operation}`),
    };
  }

  function writeAudit(
    ctx: { credentialId: string; agentName: string | null; principal: string | null } | null,
    target: string,
    recordId: string | null,
    outcome: "ok" | "rejected",
    code?: string,
  ): void {
    const entry: AuditEntry = {
      at: now().toISOString(),
      credentialId: ctx?.credentialId ?? null,
      agentName: ctx?.agentName ?? null,
      principal: ctx?.principal ?? null,
      target,
      recordId,
      outcome,
      ...(code ? { code } : {}),
    };
    audit(entry);
  }

  /* ------------------------------------------------------------- records */

  async function handleRecords(
    req: A2AppRequest,
    entity: string,
    recordId: string | null,
  ): Promise<A2AppReply> {
    const limited = rateGate(req, "data");
    if (limited) return limited;
    const defs = binding.entities();
    const def = defs[entity];
    if (!def) return err(404, "unknown_entity", `No such entity "${entity}".`);
    const serverNow = now().toISOString();

    // READ
    if (req.method === "GET") {
      const authz = authorize(req, { scope: `data:${entity}:read`, isWrite: false });
      if ("reply" in authz) return authz.reply;
      if (recordId) {
        const rec = await binding.getRecord(entity, recordId);
        if (!rec) return err(404, "record_not_found", `No ${entity} record "${recordId}".`);
        return ok(rec);
      }
      const query = {
        ...(req.query.filter !== undefined ? { filter: req.query.filter } : {}),
        ...(req.query.sort !== undefined ? { sort: req.query.sort } : {}),
        ...(req.query.perPage !== undefined ? { perPage: Number(req.query.perPage) } : {}),
        ...(req.query.page !== undefined ? { page: Number(req.query.page) } : {}),
      };
      // A binding that cannot honour the filter refuses; the alternative is
      // answering 200 with rows the caller did not ask for (section 4.2).
      let result;
      try {
        result = await binding.listRecords(entity, query);
      } catch (e) {
        if (e instanceof UnsupportedFilterError) {
          return err(400, ERROR_CODES.INVALID_FILTER, e.message, { got: e.expression });
        }
        throw e;
      }
      return ok(result);
    }

    // WRITE
    const authz = authorize(req, { scope: `data:${entity}:write`, isWrite: true });
    if ("reply" in authz) {
      writeAudit(null, `data:${entity}`, recordId, "rejected", (authz.reply.json as { code?: string }).code);
      return authz.reply;
    }
    const ctx = authz.ctx;

    if (req.method === "DELETE") {
      if (!recordId) return err(400, "usage", "DELETE requires a record id.");
      const okDel = await binding.deleteRecord(entity, recordId);
      writeAudit(ctx, `data:${entity}`, recordId, okDel ? "ok" : "rejected");
      if (!okDel) return err(404, "record_not_found", `No ${entity} record "${recordId}".`);
      markDataChanged();
      return ok({ a2app: true, ok: true, deleted: recordId });
    }

    if (req.method !== "POST" && req.method !== "PATCH") {
      return err(405, "usage", `${req.method} not allowed on records.`);
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Idempotency: a replayed key returns 409 naming the record. Applied to both
    // creates (POST) and updates (PATCH) — a retried non-idempotent PATCH would
    // otherwise re-apply, so an in-flight retry after a lost response must dedup.
    // Namespaced by record on PATCH so a key is scoped to the row it targeted.
    const idemKey = req.headers["idempotency-key"];
    // POST keys are scoped to the entity; PATCH keys to the specific row, so a
    // create key and an update key can never collide. A PATCH without a record id
    // is malformed (handled below) — don't run idempotency for it.
    const idemActive = !!idemKey && (req.method === "POST" || (req.method === "PATCH" && !!recordId));
    const idemScope = req.method === "PATCH" ? `${entity}#${recordId}` : entity;
    if (idemActive) {
      const prior = store.idempotencyGet(idemScope, idemKey!);
      if (prior) {
        return err(409, ERROR_CODES.DUPLICATE_REQUEST, "This idempotency key was already applied.", {
          id: prior.recordId,
        });
      }
    }

    // Guard the RAW body before any backend coercion. Required-field presence is
    // enforced on CREATE only (POST) — a PATCH is a legitimate partial write.
    // Null prototype: `allow` is probed with keys from the request body, and on a
    // plain object `allow["constructor"]` is truthy, which makes validate() skip
    // that field entirely rather than guard it.
    const allow: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const k of def.writeAllow ?? []) allow[k] = true;
    const violations = validate(def.fields, body, { allow, requireRequired: req.method === "POST" });
    if (violations.length) {
      writeAudit(ctx, `data:${entity}`, recordId, "rejected", violations[0]!.code);
      return guardEnvelope(violations, serverNow);
    }

    // Backend write.
    let stored;
    if (req.method === "POST") {
      stored = await binding.createRecord(entity, body);
    } else {
      if (!recordId) return err(400, "usage", "PATCH requires a record id.");
      stored = await binding.updateRecord(entity, recordId, body);
      if (!stored) return err(404, "record_not_found", `No ${entity} record "${recordId}".`);
    }

    // Read-back: did every non-blank requested value land?
    const lost = divergences(def.fields, body, (name) => (stored as Record<string, unknown>)[name]);
    if (lost.length) {
      writeAudit(ctx, `data:${entity}`, stored.id, "rejected", ERROR_CODES.NOT_STORED);
      return {
        status: 422,
        json: {
          a2app: true,
          ok: false,
          code: ERROR_CODES.NOT_STORED,
          message: describeIncomplete(lost),
          violations: lost.map((l) => ({ code: ERROR_CODES.NOT_STORED, field: l.field })),
          id: stored.id,
        },
      };
    }

    if (idemActive) store.idempotencyPut(idemScope, idemKey!, stored.id);
    writeAudit(ctx, `data:${entity}`, stored.id, "ok");
    markDataChanged();
    return ok(stored, 200);
  }

  /* ---------------------------------------------------------- operations */
  /**
   * A declared operation's parameters, in the shape the shared guard validates.
   *
   * An operation IS a write — many of them destructive — so its arguments belong
   * on the same rules as a record write rather than on a second, weaker path.
   * Without this the chain in this file's header skipped `guard` for every
   * operation: an undeclared parameter, a value outside a declared enum, a
   * malformed ref and a missing REQUIRED parameter all reached the binding and
   * came back `ok: true` — the silent success the protocol exists to prevent.
   */
  function paramFields(decl: OperationDecl): NormalizedField[] {
    return Object.entries(decl.params ?? {}).map(([name, p]) => {
      const field: NormalizedField = { name, type: p.type };
      if (p.required !== undefined) field.required = p.required;
      if (p.max !== undefined) field.max = p.max;
      if (p.values !== undefined) field.values = p.values;
      if (p.entity !== undefined) field.entity = p.entity;
      return field;
    });
  }



  async function handleOperation(req: A2AppRequest, name: string): Promise<A2AppReply> {
    const limited = rateGate(req, "ops");
    if (limited) return limited;
    const decl = opByName.get(name);
    if (!decl) return err(404, "unknown_operation", `No declared operation "${name}".`);
    const authz = authorize(req, { scope: `op:${name}`, isWrite: !decl.readOnly });
    if ("reply" in authz) return authz.reply;
    const ctx = authz.ctx;
    const args = (req.body ?? {}) as Record<string, unknown>;

    // Guard the RAW args before anything acts on them, and before an approval
    // key is minted: a human must never be asked to approve a call that cannot
    // run. Every parameter is supplied fresh on each invocation — there is no
    // partial-update case here — so a declared `required` is always enforced.
    const argViolations = validate(paramFields(decl), args, { requireRequired: true });
    if (argViolations.length) {
      writeAudit(ctx, `op:${name}`, null, "rejected", argViolations[0]!.code);
      return guardEnvelope(argViolations, now().toISOString());
    }

    // Idempotency: a non-idempotent operation carrying an Idempotency-Key must not
    // double-execute on a retry. A replayed key is a 409 (reject-duplicate), same
    // as records. Namespaced under `op:<name>` so keys never collide with record
    // keys. Checked before approval/run; the key is only recorded after a success,
    // so a first call that 428s (approval) or throws leaves the retry free to run.
    const idemKey = req.headers["idempotency-key"];
    const idemScope = `op:${name}`;
    if (idemKey) {
      const prior = store.idempotencyGet(idemScope, idemKey);
      if (prior) {
        return err(409, ERROR_CODES.DUPLICATE_REQUEST, "This idempotency key already ran this operation.", {
          operation: name,
        });
      }
    }

    // Approval: a destructive op needs a content-addressed key.
    if (decl.destructive) {
      const key = approvalKey(name, args);
      const provided = req.headers["x-a2app-approval"] ?? req.headers["x-lui-approval"];
      if (!provided) {
        store.approvalIssue(key);
        return err(428, ERROR_CODES.APPROVAL_REQUIRED, `Operation "${name}" is destructive and requires approval.`, {
          approvalKey: key,
        });
      }
      if (provided !== key || !store.approvalConsume(key)) {
        return err(428, ERROR_CODES.APPROVAL_REQUIRED, "Approval key does not match this exact call (or has expired).", {
          approvalKey: key,
        });
      }
    }

    if (!binding.runOperation) {
      return err(501, "not_implemented", `This app declares "${name}" but implements no operation runner.`);
    }
    try {
      const result = await binding.runOperation(name, args, ctx);
      if (idemKey) store.idempotencyPut(idemScope, idemKey, name);
      // A declared read-only operation promises no side effects; everything else
      // is assumed to have touched data, because the adapter cannot see into the
      // binding to check. Erring towards "changed" costs an open tab one refetch;
      // erring the other way leaves it silently stale, which is the bug.
      if (decl.readOnly !== true) markDataChanged();
      writeAudit(ctx, `op:${name}`, null, "ok");
      return ok({ a2app: true, ok: true, operation: name, result });
    } catch (e) {
      if (e instanceof OperationError) {
        writeAudit(ctx, `op:${name}`, null, "rejected", e.code);
        return err(e.httpStatus, e.code, e.message, e.extra ?? {});
      }
      writeAudit(ctx, `op:${name}`, null, "rejected", "operation_failed");
      return err(500, "operation_failed", `Operation "${name}" threw: ${(e as Error).message}`);
    }
  }

  /* ------------------------------------------------------- tasks / events */

  function taskWire(t: StoredTask): Record<string, unknown> {
    return {
      id: t.id,
      app: t.app,
      event: t.event,
      status: t.status,
      request: t.request,
      claim: t.claim,
      progress: t.progress,
      result: t.result,
      reason: t.reason,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      pollAfterMs: 2000,
    };
  }

  async function handleTasks(req: A2AppRequest, rest: string[]): Promise<A2AppReply> {
    const limited = rateGate(req, "data");
    if (limited) return limited;
    const authz = authorize(req, { scope: null, isWrite: req.method !== "GET" });
    if ("reply" in authz) return authz.reply;
    const ctx = authz.ctx;

    store.sweep(TASK_TIMEOUT_MS, TASK_MAX_DELIVERIES);

    // GET /api/_a2app/tasks?status=submitted
    if (rest.length === 0 && req.method === "GET") {
      const status = req.query.status;
      const tasks = store.listTasks(status).map(taskWire);
      return ok({ a2app: true, tasks, pollAfterMs: 2000 });
    }
    const taskId = rest[0];
    if (!taskId) return err(400, "usage", "Task id required.");
    const action = rest[1];

    const task = store.getTask(taskId);
    if (!task) return err(404, ERROR_CODES.TASK_NOT_FOUND, `No task "${taskId}".`);

    // GET /api/_a2app/tasks/{id}
    if (action === undefined && req.method === "GET") return ok(taskWire(task));

    if (req.method !== "POST") return err(405, "usage", `${req.method} not allowed here.`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    switch (action) {
      case "claim": {
        if (task.status !== "submitted") {
          writeAudit(ctx, `task:claim`, taskId, "rejected", ERROR_CODES.TASK_NOT_CLAIMABLE);
          return err(409, ERROR_CODES.TASK_NOT_CLAIMABLE, `Task ${taskId} is ${task.status}, not claimable.`);
        }
        // Honor an explicit principal in the body ONLY when it names the caller's
        // own authenticated credential (the SDK sends `{agent: <credentialId>}`).
        // A body naming a DIFFERENT credential is a claim-as-someone-else attempt —
        // refuse it rather than silently recording the true caller under a false
        // affordance. Absent/blank means "claim as me", the common path.
        const requested = typeof body.agent === "string" && body.agent ? body.agent : null;
        if (requested && requested !== ctx.credentialId && requested !== ctx.agentName) {
          writeAudit(ctx, `task:claim`, taskId, "rejected", "principal_mismatch");
          return err(403, "principal_mismatch", `Cannot claim task ${taskId} as "${requested}": the credential presented is ${ctx.credentialId}.`, {
            requested,
            actual: ctx.credentialId,
          });
        }
        task.status = "working";
        task.claim = { credentialId: ctx.credentialId, principal: ctx.principal, claimedAt: now().toISOString() };
        store.saveTask(task);
        writeAudit(ctx, `task:claim`, taskId, "ok");
        return ok(taskWire(task));
      }
      case "progress": {
        if (task.status === "canceled") return err(409, ERROR_CODES.TASK_CANCELED, `Task ${taskId} was canceled.`);
        if (task.status !== "working" && task.status !== "input-required") {
          return err(409, ERROR_CODES.TASK_NOT_CLAIMABLE, `Task ${taskId} is ${task.status}.`);
        }
        if (typeof body.step === "string") task.progress.step = body.step;
        if (typeof body.percent === "number") task.progress.percent = body.percent;
        if (body.ask !== undefined) {
          task.ask = body.ask;
          task.status = "input-required";
        } else if (task.status === "input-required") {
          task.status = "working";
        }
        store.saveTask(task);
        writeAudit(ctx, `task:progress`, taskId, "ok");
        return ok(taskWire(task));
      }
      case "complete": {
        if (task.status === "canceled") return err(409, ERROR_CODES.TASK_CANCELED, `Task ${taskId} was canceled.`);
        // A terminal write belongs to the claimer: completion closes a claim, so
        // a task nobody claimed has no claim to close. Allowing `submitted ->
        // completed` would skip the claim that binds the run to a named principal
        // (section 6.5) and would let a task be reported done by a party that
        // never did the work.
        if (task.status !== "working" && task.status !== "input-required") {
          return err(409, ERROR_CODES.TASK_NOT_CLAIMABLE, `Task ${taskId} is ${task.status}, not in progress.`);
        }
        const status = body.status;
        if (status === "completed") {
          task.status = "completed";
          task.result = (body.result as Record<string, unknown>) ?? {};
        } else if (status === "failed") {
          task.status = "failed";
          task.reason = typeof body.reason === "string" ? body.reason : "unspecified";
        } else {
          return err(400, "usage", 'complete requires status "completed" or "failed".');
        }
        store.saveTask(task);
        writeAudit(ctx, `task:complete`, taskId, "ok", task.status === "failed" ? "failed" : undefined);
        return ok(taskWire(task));
      }
      case "cancel": {
        // Terminal is terminal: every task reaches a terminal state once
        // (section 6.3). Re-labelling a completed or failed task as canceled
        // would move it backwards through the lifecycle and rewrite the recorded
        // outcome of work that already finished.
        if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
          return err(409, ERROR_CODES.TASK_NOT_CLAIMABLE, `Task ${taskId} already reached ${task.status}.`);
        }
        task.status = "canceled";
        store.saveTask(task);
        writeAudit(ctx, `task:cancel`, taskId, "ok");
        return ok(taskWire(task));
      }
      default:
        return err(404, "usage", `Unknown task action "${action}".`);
    }
  }

  function handleEvents(req: A2AppRequest): A2AppReply {
    const limited = rateGate(req, "data");
    if (limited) return limited;
    const authz = authorize(req, { scope: null, isWrite: false });
    if ("reply" in authz) return authz.reply;
    const since = req.query.since ?? null;
    const { events, nextCursor } = store.eventsSince(since);
    return ok({
      a2app: true,
      events: events.map((e) => ({ id: e.id, app: e.app, type: e.type, payload: e.payload, createdAt: e.createdAt })),
      nextCursor,
      pollAfterMs: 3000,
    });
  }

  /* -------------------------------------------------------------- router */

  async function handle(req: A2AppRequest): Promise<A2AppReply | null> {
    const path = req.path.replace(/\/+$/, "") || "/";

    // Before any route, including the unauthenticated identity document, which
    // is otherwise a free fingerprint of the app for a rebound page.
    const hostHeader = req.headers["host"];
    if (hostHeader !== undefined && !isAllowedHost(hostHeader)) {
      return err(403, "forbidden_host", `Refused: this app answers only on its own host, not "${hostHeader}".`);
    }

    // Identity (unauthenticated).
    if (path === "/.well-known/a2app.json" || path === "/api/_a2app") {
      // The update watcher polls this every few seconds anyway, so its "I am
      // still here" rides along as a header. Adding a second endpoint would have
      // doubled every open tab's request rate to learn the same fact.
      noteViewer(req);
      return ok(identityDoc());
    }
    // How many people have this app open. A COUNT only, and behind a credential:
    // unauthenticated, "how many people are using this right now" is a fact a
    // deployed app should not hand to anyone who asks.
    if (path === "/api/_a2app/viewers") {
      const authz = authorize(req, { scope: null, isWrite: false });
      if ("reply" in authz) return authz.reply;
      return ok({ a2app: true, viewers: countViewers(), ttlMs: VIEWER_TTL_MS });
    }
    // Describe is navigational: the bare path is the root level, and each extra
    // segment moves one level inward (A2APP-SPEC 3). Segments are decoded here
    // because a record id or entity name may legitimately contain an escaped
    // character, and the deeper levels look them up verbatim.
    if (path === "/api/_a2app/describe") return handleDescribe(req, []);
    if (path.startsWith(DESCRIBE_PREFIX)) {
      const segments = path.slice(DESCRIBE_PREFIX.length).split("/").map(decodeURIComponent);
      if (segments.length > 4) {
        return err(404, "usage", "describe goes at most four levels deep: {module}/{entity}/{id}/{relation}.");
      }
      if (segments.some((s) => s === "")) return err(404, "usage", "describe path has an empty segment.");
      return handleDescribe(req, segments);
    }
    if (path === "/api/_a2app/whoami") {
      const grant = credentialOf(req);
      // The same `how` the write path sends. whoami is where a caller checks its
      // grant BEFORE planning work, so it is the first 401 many agents meet — and
      // a bare challenge here sends them back to a step whose whole input is this
      // field.
      if (!grant) {
        return err(401, ERROR_CODES.AGENT_TOKEN_REQUIRED, "whoami requires a credential.", {
          how: config.credentialHint ?? DEFAULT_CREDENTIAL_HINT,
        });
      }
      return ok({
        a2app: true,
        credentialId: grant.credentialId,
        agentName: grant.agentName,
        principal: grant.principal,
        scopes: [...expandScopes(grant)].sort(),
      });
    }
    if (path === "/api/_a2app/context") {
      const authz = authorize(req, { scope: null, isWrite: false });
      if ("reply" in authz) return authz.reply;
      const c = binding.context ? await binding.context() : { view: null, selected: [] };
      return ok({ a2app: true, view: c.view, selected: c.selected });
    }
    if (path === "/api/_a2app/events") return handleEvents(req);
    if (path === "/api/_a2app/tasks" || path.startsWith("/api/_a2app/tasks/")) {
      const rest = path === "/api/_a2app/tasks" ? [] : path.slice("/api/_a2app/tasks/".length).split("/");
      return handleTasks(req, rest);
    }

    // Records: /api/collections/{entity}/records[/{id}]
    const rec = path.match(/^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/);
    if (rec) return handleRecords(req, decodeURIComponent(rec[1]!), rec[2] ? decodeURIComponent(rec[2]) : null);

    // Operations: /api/ops/{name}
    const op = path.match(/^\/api\/ops\/([^/]+)$/);
    if (op) {
      if (req.method !== "POST") return err(405, "usage", "Operations are POST-only.");
      return handleOperation(req, decodeURIComponent(op[1]!));
    }

    return null; // not an A2App path — the host app handles it
  }

  return {
    handle,
    identity: identityDoc,
    store,
    trigger(input) {
      if (!eventTypes.has(input.type) && eventTypes.size > 0) {
        throw new Error(`event type "${input.type}" is not declared`);
      }
      const ev = store.appendEvent(input.type, input.payload);
      let taskId: string | null = null;
      if (input.capability) {
        const task = store.enqueueTask({
          event: ev.id,
          capability: input.capability,
          payload: input.payload,
          // Dedup is keyed on the OCCURRENCE, not on the event record: the same
          // trigger firing twice must make one task (section 6.2). `ev.id` is
          // freshly minted per emit, so defaulting to it deduplicates nothing.
          // The occurrence is what the app asked for — its type, the capability
          // it requests, and its payload — canonicalized so two identical
          // triggers hash identically regardless of key order.
          dedupKey:
            input.dedupKey ??
            sha256Prefixed(
              canonicalize({ type: input.type, capability: input.capability, payload: input.payload ?? null }),
            ),
        });
        taskId = task.id;
      }
      return { eventId: ev.id, taskId };
    },
  };
}

export type { Binding, A2AppConfig, EntityDef, OperationDecl, Grant, CallContext } from "./types.js";
