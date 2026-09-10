/**
 * @a2app/adapter-core types — the contract between the stack-agnostic served
 * surface (front face) and a stack-specific backend binding (back face). An
 * adapter author implements {@link Binding}; the core serves every A2App
 * endpoint on top of it.
 */
import type { NormalizedField, Predicate } from "@a2app/rules";

/* ----------------------------------------------------------------- schema */

/** One declared module: an app's organizing unit, and one row of describe's root
 *  level. Every entity and every operation belongs to exactly one. */
export interface ModuleDecl {
  name: string;
  /** one line, shown on the root screen */
  summary?: string;
}

/** One entity as the binding exposes it, already mapped to protocol types. */
export interface EntityDef {
  /** protocol-typed fields (never the backend's native types) */
  fields: NormalizedField[];
  /**
   * Which declared module this entity lives in. Required: an entity outside
   * every module has no screen to appear on and is unreachable by the walk.
   */
  module: string;
  /** one line, shown on the module screen beside the entity's name */
  summary?: string;
  /** true if the entity is an auth/accounts collection (describe `auth: true`) */
  auth?: boolean;
  /**
   * Extra body keys accepted on a write without being declared fields
   * (e.g. `password`/`passwordConfirm` on an auth signup). Passed to the guard's
   * allow-list so they are neither rejected as unknown nor validated as fields.
   */
  writeAllow?: string[];
}

/** A stored record as the backend returns it. Must include an `id`. */
export type StoredRecord = Record<string, unknown> & { id: string };

export interface ListQuery {
  filter?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface ListResult {
  items: StoredRecord[];
  page?: number;
  perPage?: number;
  totalItems?: number;
}

/* -------------------------------------------------------------- operations */

/** One typed operation parameter. Same vocabulary as an entity field, so a
 *  signature renders with the types an agent already knows. */
export type ParamDef = Omit<NormalizedField, "name" | "readOnly" | "writeOnly" | "dayKey"> & {
  description?: string;
  format?: string;
};

/** A declared operation (operations.json / describe). */
export interface OperationDecl {
  name: string;
  description?: string;
  destructive: boolean;
  /** advisory: no side effects */
  readOnly?: boolean;
  /** advisory: safe to repeat without an Idempotency-Key */
  idempotent?: boolean;
  /**
   * Which declared module this operation appears under. Required for the same
   * reason as {@link EntityDef.module}: an operation with nowhere to appear
   * cannot be found by walking.
   */
  module: string;
  /**
   * The entity this operation acts on. Absent means module-level: it shows on
   * the module screen only, never on a record.
   */
  entity?: string;
  /**
   * When this operation is available on a record, as a schema-based predicate
   * over that record's own fields. Requires {@link OperationDecl.entity}.
   * Evaluated by the adapter; a model never decides availability.
   */
  appliesWhen?: Predicate;
  /**
   * Typed parameters. Required — the record level renders this as the
   * operation's signature, and arguments described in prose inside
   * `description` can be neither rendered nor checked. An operation that takes
   * no arguments declares `{}`.
   */
  params: Record<string, ParamDef>;
  /** true for framework-provided ops; excluded from nothing, marked in canon */
  system?: boolean;
}

/** Context in which an operation or write executes: who is acting. */
export interface CallContext {
  credentialId: string;
  agentName: string | null;
  principal: string;
}

/* ---------------------------------------------------------------- binding */

/**
 * The back face: everything stack-specific. The core calls these; the binding
 * never speaks HTTP, never renders envelopes, never validates (validation is the
 * shared pure-rules layer). It maps types, reads the live schema, and
 * stores/reads records + runs operations.
 */
export interface Binding {
  readonly appId: string;
  readonly appName: string | null;
  readonly adapterVersion: string;
  readonly authMode: "none" | "multi-user";

  /** The live data model, mapped to protocol types. Read fresh so describe and
   *  schemaVersion cannot drift ("derive, do not declare"). */
  entities(): Record<string, EntityDef>;

  listRecords(entity: string, query: ListQuery): Promise<ListResult> | ListResult;
  getRecord(entity: string, id: string): Promise<StoredRecord | null> | StoredRecord | null;
  createRecord(entity: string, body: Record<string, unknown>): Promise<StoredRecord> | StoredRecord;
  updateRecord(
    entity: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<StoredRecord | null> | StoredRecord | null;
  deleteRecord(entity: string, id: string): Promise<boolean> | boolean;

  /** Execute a declared operation. Throw {@link OperationError} to reject with a
   *  machine code; return any JSON for success. */
  runOperation?(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<unknown> | unknown;

  /** What the user is looking at. Ids only, never record data. Optional;
   *  defaults to an empty context. */
  context?(): Promise<ContextResult> | ContextResult;
}

export interface ContextResult {
  view: string | null;
  selected: { entity: string; id: string }[];
}

/** Thrown by a binding's `runOperation` to reject with a machine code. */
export class OperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

/* -------------------------------------------------------- IAM / credentials */

/** A grant: one credential, one principal, a scope set. */
export interface Grant {
  token: string;
  credentialId: string;
  agentName: string | null;
  principal: string;
  /** `data:<entity>:read` · `data:<entity>:write` · `op:<name>`, or `*` for the
   *  v1 all-access local default (expanded to concrete scopes in whoami). */
  scopes: string[];
}

/* ---------------------------------------------------------------- events */

/** A declared event type. Undeclared events are never emitted. */
export interface EventTypeDecl {
  type: string;
  /** JSON-schema-ish declaration of the payload (informational for v0.1). */
  payload?: Record<string, unknown>;
}

/* --------------------------------------------------------- request/reply */

/** A framework-agnostic request the core routes. A host adapts its own
 *  http/middleware request into this shape. */
export interface A2AppRequest {
  method: string;
  /** path only, no query string, e.g. /api/collections/cards/records */
  path: string;
  query: Record<string, string>;
  /** lower-cased header names */
  headers: Record<string, string | undefined>;
  /** parsed JSON body (or undefined) */
  body?: unknown;
}

export interface A2AppReply {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

/* ---------------------------------------------------------------- config */

export interface A2AppConfig {
  /** seeded grants; the first is the primary local agent. */
  credentials?: Grant[];
  /** the adapter-owned state store. When omitted, the core builds a durable
   *  {@link import("./store.js").FileStateStore} if `storePath` is given, else an
   *  in-memory store (fast, but non-conforming for idempotency across a restart).
   *  Pass an explicit store to override both. */
  store?: import("./store.js").StateStore;
  /** filesystem path for the default durable store's snapshot. Supply this (a
   *  stable file under the app's data dir) and the core defaults to a
   *  FileStateStore, so the idempotency table SURVIVES A RESTART — which is
   *  exactly when a retry arrives. Ignored when `store` is passed. */
  storePath?: string;
  /** rate limits. Defaults to data 1200/min, ops 300/min; pass
   *  `{ data: 0, ops: 0 }` to disable. */
  rateLimits?: Partial<import("./rate.js").RateLimits>;
  /** declared operations (from operations.json). */
  operations?: OperationDecl[];
  /**
   * The app's declared modules, in the order the root screen lists them.
   *
   * Required: every entity and operation names one, the root screen lists them,
   * and an app with none has no root screen to serve. `createA2App` refuses a
   * config without them rather than serving an app that cannot be walked — the
   * type says so too, so the refusal is a compile error wherever it can be.
   */
  modules: ModuleDecl[];
  /** app-authored conventions merged into the protocol defaults. */
  conventions?: Record<string, unknown>;
  /** the app's own origins; a write from any other Origin is refused 403. */
  allowedOrigins?: string[];
  /** Host names to answer on, beyond loopback and the hosts of allowedOrigins.
   *  Set this only when the app is deliberately reachable under another name. */
  allowedHosts?: string[];
  /** declared event types. */
  events?: EventTypeDecl[];
  /** injectable clock, for deterministic tests. */
  now?: () => Date;
  /** how a credential is obtained, surfaced in the 401 challenge. */
  credentialHint?: string;
  /** dev|live marker for identity.env (safe-evolve, non-normative). */
  env?: string;
  /**
   * The app's own CODE version, published as identity's `appVersion`.
   *
   * `schemaVersion` fingerprints the MODEL and nothing else, on purpose: it is
   * the key clients cache describe against, so it must move for exactly the
   * changes that invalidate describe. That makes it blind to everything else the
   * app is built from — a new View control, a CSS change, reworded copy, an
   * operation's description — and therefore useless as an "is my code stale?"
   * signal for a browser tab that loaded the View minutes ago.
   *
   * `appVersion` is that second marker, and it is deliberately NOT part of the
   * describe cache key at the protocol level: the two answer different questions
   * and collapsing them would make every asset edit look like a model change.
   *
   * A function is re-evaluated per request, so a value derived from files on
   * disk stays truthful while the process runs. Return null/undefined (or omit
   * the field) and identity simply carries no `appVersion` — it is an optional
   * extension, and no client may require it.
   */
  appVersion?: string | (() => string | null | undefined);
  /** append-only audit sink. Defaults to an in-memory ring. */
  audit?: (entry: AuditEntry) => void;
}

/**
 * Thrown by a {@link Binding} when a `filter` falls outside the query grammar
 * it implements. The served surface turns it into an `invalid_filter` rejection.
 *
 * A filtered read MUST filter (section 4.2). A binding that cannot honour an
 * expression has exactly two honest options — refuse, or implement it — because
 * returning unfiltered rows answers 200 with the wrong records and returning
 * none answers 200 with a false empty. Both read as a correct filtered read to
 * the caller, and label resolution is built on filtered reads. This error is how
 * a binding refuses.
 */
export class UnsupportedFilterError extends Error {
  constructor(readonly expression: string) {
    super(`filter expression is not supported by this backend: ${expression}`);
    this.name = "UnsupportedFilterError";
  }
}

/** One audit row: every credentialed write is appended. */
export interface AuditEntry {
  at: string;
  credentialId: string | null;
  agentName: string | null;
  principal: string | null;
  target: string;
  recordId: string | null;
  outcome: "ok" | "rejected";
  code?: string;
}
