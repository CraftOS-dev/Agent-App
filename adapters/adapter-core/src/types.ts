/**
 * @a2app/adapter-core types — the contract between the stack-agnostic served
 * surface (front face) and a stack-specific backend binding (back face). An
 * adapter author implements {@link Binding}; the core serves every A2App
 * endpoint on top of it.
 */
import type { NormalizedField } from "@a2app/rules";

/* ----------------------------------------------------------------- schema */

/** One entity as the binding exposes it, already mapped to protocol types. */
export interface EntityDef {
  /** protocol-typed fields (never the backend's native types) */
  fields: NormalizedField[];
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

/** A declared operation (operations.json / describe). */
export interface OperationDecl {
  name: string;
  description?: string;
  destructive: boolean;
  /** advisory: no side effects */
  readOnly?: boolean;
  /** advisory: safe to repeat without an Idempotency-Key */
  idempotent?: boolean;
  params?: Record<string, unknown>;
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
  /** the adapter-owned state store. Defaults to in-memory; pass a persistent one
   *  (e.g. FileStateStore) so idempotency survives a restart. */
  store?: import("./store.js").StateStore;
  /** rate limits. Defaults to data 1200/min, ops 300/min; pass
   *  `{ data: 0, ops: 0 }` to disable. */
  rateLimits?: Partial<import("./rate.js").RateLimits>;
  /** declared operations (from operations.json). */
  operations?: OperationDecl[];
  /** app-authored conventions merged into the protocol defaults. */
  conventions?: Record<string, unknown>;
  /** the app's own origins; a write from any other Origin is refused 403. */
  allowedOrigins?: string[];
  /** declared event types. */
  events?: EventTypeDecl[];
  /** injectable clock, for deterministic tests. */
  now?: () => Date;
  /** how a credential is obtained, surfaced in the 401 challenge. */
  credentialHint?: string;
  /** dev|live marker for identity.env (safe-evolve, non-normative). */
  env?: string;
  /** append-only audit sink. Defaults to an in-memory ring. */
  audit?: (entry: AuditEntry) => void;
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
