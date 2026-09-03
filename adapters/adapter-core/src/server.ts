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
  type NormalizedField,
  type Violation,
} from "@a2app/rules";
import { approvalKey } from "./canon.js";
import { FileStateStore, InMemoryStateStore, knownEventTypes, type StateStore, type StoredTask } from "./store.js";
import { RateLimiter, DEFAULT_RATE_LIMITS, type RouteClass } from "./rate.js";
import {
  OperationError,
  type A2AppConfig,
  type A2AppReply,
  type A2AppRequest,
  type AuditEntry,
  type Binding,
  type CallContext,
  type Grant,
} from "./types.js";

export const ADAPTER_CORE_VERSION = "0.1.0";
const PROTOCOL_VERSION = "0.1";
const TASK_TIMEOUT_MS = 60_000;
const TASK_MAX_DELIVERIES = 5;

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

export function createA2App(binding: Binding, config: A2AppConfig = {}): A2App {
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
  const audit = config.audit ?? ((e: AuditEntry) => store.appendAudit(e));
  const limiter = new RateLimiter({ ...DEFAULT_RATE_LIMITS, ...(config.rateLimits ?? {}) }, () => now().getTime());

  // Seed grants (the platform issues the default local grant at launch).
  for (const g of config.credentials ?? []) store.putGrant(g);

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

  function normalizedEntities(): Record<string, NormalizedField[]> {
    const defs = binding.entities();
    const out: Record<string, NormalizedField[]> = {};
    for (const [name, def] of Object.entries(defs)) out[name] = def.fields;
    return out;
  }

  function schemaVersion(): string {
    return schemaFingerprint(normalizedEntities());
  }

  function describeDoc(): Record<string, unknown> {
    const defs = binding.entities();
    const entities: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(defs)) {
      const fields: Record<string, unknown> = {};
      for (const f of def.fields) {
        if (f.writeOnly) continue; // never advertised
        const field: Record<string, unknown> = { type: f.type };
        if (f.required) field.required = true;
        if (f.readOnly) field.readOnly = true;
        if (f.max !== undefined) field.max = f.max;
        if (f.values) field.values = f.values;
        if (f.entity) field.entity = f.entity;
        if (f.dayKey) field.format = "YYYY-MM-DD";
        fields[f.name] = field;
      }
      const entity: Record<string, unknown> = {
        label: labelFieldOf(def.fields),
        records: `/api/collections/${name}/records`,
        fields,
      };
      if (def.auth) entity.auth = true;
      entities[name] = entity;
    }
    const ops = operations.map((o) => {
      const decl: Record<string, unknown> = { name: o.name, destructive: o.destructive };
      if (o.description) decl.description = o.description;
      if (o.readOnly) decl.readOnly = true;
      if (o.idempotent) decl.idempotent = true;
      if (o.params) decl.params = o.params;
      return decl;
    });
    return { entities, operations: ops, conventions: conventions() };
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
      serverNow: d.toISOString(),
      serverTzOffsetMinutes: -d.getTimezoneOffset(),
    };
    if (config.env) doc.env = config.env;
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
            how: config.credentialHint ?? "Read the app's .agent-token file (mode 0600) in the project directory.",
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
      const result = await binding.listRecords(entity, query);
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
    const allow: Record<string, unknown> = {};
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
    return ok(stored, 200);
  }

  /* ---------------------------------------------------------- operations */

  async function handleOperation(req: A2AppRequest, name: string): Promise<A2AppReply> {
    const limited = rateGate(req, "ops");
    if (limited) return limited;
    const decl = opByName.get(name);
    if (!decl) return err(404, "unknown_operation", `No declared operation "${name}".`);
    const authz = authorize(req, { scope: `op:${name}`, isWrite: !decl.readOnly });
    if ("reply" in authz) return authz.reply;
    const ctx = authz.ctx;
    const args = (req.body ?? {}) as Record<string, unknown>;

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

    // Identity (unauthenticated).
    if (path === "/.well-known/a2app.json" || path === "/api/_a2app") {
      return ok(identityDoc());
    }
    if (path === "/api/_a2app/describe") return ok(describeDoc());
    if (path === "/api/_a2app/whoami") {
      const grant = credentialOf(req);
      if (!grant) return err(401, ERROR_CODES.AGENT_TOKEN_REQUIRED, "whoami requires a credential.");
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
          dedupKey: input.dedupKey ?? ev.id,
        });
        taskId = task.id;
      }
      return { eventId: ev.id, taskId };
    },
  };
}

export type { Binding, A2AppConfig, EntityDef, OperationDecl, Grant, CallContext } from "./types.js";
