/**
 * A2App protocol wire types (protocol 0.1).
 *
 * These mirror the normative JSON Schemas in `spec/v0_1/schema/*.json`. Where
 * these types and a schema disagree, the schema wins.
 */
import type { ProtocolType } from "@a2app/rules";

export const PROTOCOL_VERSION = "0.1";

/** Wire `protocol` values a 0.1 client accepts. Some adapters may still report
 *  "1.0"; it is an alias of "0.1" during the transition window. */
export const ACCEPTED_PROTOCOLS = ["0.1", "1.0"] as const;

/** `GET /.well-known/a2app.json` and `GET /api/_a2app`. */
export interface Identity {
  a2app: true;
  protocol: string;
  adapterVersion: string;
  app: { id: string; name?: string | null };
  schemaVersion: string;
  serverNow: string;
  serverTzOffsetMinutes: number;
  /** non-normative extension used by safe-evolve: "dev" | "live" */
  env?: string;
  /**
   * Non-normative extension: an opaque marker of the app's own CODE version.
   *
   * `schemaVersion` fingerprints the model, so it is blind to anything that does
   * not change entities or operations — a View edit, reworded copy, an
   * operation's description. `appVersion` moves for those. A client that must
   * know whether the app it loaded has been superseded compares BOTH; one that
   * only caches describe still keys on `schemaVersion` alone. Absent on apps
   * that do not publish it.
   */
  appVersion?: string;
}

/** A field as `describe` reports it — protocol types, not the backend's. */
export interface DescribeField {
  type: ProtocolType;
  required?: boolean;
  readOnly?: boolean;
  max?: number;
  values?: string[];
  /** target entity for ref / list<ref> */
  entity?: string;
  /** e.g. "YYYY-MM-DD" for a day-key field */
  format?: string;
}

export interface OperationDecl {
  name: string;
  description?: string;
  destructive: boolean;
  readOnly?: boolean;
  idempotent?: boolean;
  /** the entity this operation acts on; absent = module-level */
  entity?: string;
  /** typed parameters, in the same vocabulary as entity fields */
  params: Record<string, DescribeField>;
}

/* ------------------------------------------------- describe: the six levels */

/**
 * `GET /api/_a2app/describe[/{path}]` — one level of the navigational surface
 * (A2APP-SPEC 3). Discriminated by `level`; every level carries `next`, the
 * legal moves from where the caller landed.
 */
export type DescribeLevel =
  | DescribeRoot
  | DescribeModule
  | DescribeEntity
  | DescribeRecord
  | DescribeRelation
  | DescribeFind;

/** How much of a module the calling credential can reach. */
export type ModuleAccess = "full" | "read-only" | "none";

/** The app's home screen: O(modules), never O(entities). */
export interface DescribeRoot {
  level: "root";
  app: { id: string; name?: string | null };
  modules: {
    name: string;
    summary?: string;
    entities: number;
    operations: number;
    access: ModuleAccess;
  }[];
  conventions: Record<string, unknown>;
  next: string[];
}

/** A module's contents by name, never by schema. */
export interface DescribeModule {
  level: "module";
  path: string;
  summary?: string;
  entities: { name: string; summary?: string }[];
  operations: { name: string; summary?: string; destructive: boolean }[];
  /** entries omitted to fit the budget; always reported, never silent */
  truncated?: number;
  next: string[];
}

/** The first level carrying schemas — for one entity. */
export interface DescribeEntity {
  level: "entity";
  path: string;
  label: string | null;
  records: string;
  auth?: boolean;
  fields: Record<string, DescribeField>;
  operations: OperationDecl[];
  next: string[];
}

/** One record, and which operations its current state allows. */
export interface DescribeRecord {
  level: "record";
  path: string;
  id: string;
  label: string | null;
  operations: {
    name: string;
    available: boolean;
    destructive?: boolean;
    /** why, when `available` is false — derived from the record, never composed */
    blocked?: string;
    /** the parameter that takes this record, when the operation names one
     *  unambiguously; absent when the caller must pass the target explicitly */
    targetParam?: string;
  }[];
  relations?: { name: string; entity: string; count?: number }[];
  next: string[];
}

/** A record's sub-resource. */
export interface DescribeRelation {
  level: "relation";
  path: string;
  entity: string;
  items: { id: string; label?: string | null }[];
  truncated?: number;
  next: string[];
}

/** Name search across the app, returning locations only. */
export interface DescribeFind {
  level: "find";
  term: string;
  matches: { path: string; level?: "module" | "entity"; operation?: string }[];
  truncated?: number;
  next: string[];
}

/** A single guard rejection. */
export interface Violation {
  code: string;
  field: string;
  expected?: string;
  got?: unknown;
}

/** The error envelope on any rejection. */
export interface ErrorEnvelope {
  a2app: true;
  ok: false;
  code: string;
  field?: string;
  expected?: string;
  got?: unknown;
  required?: string;
  id?: string;
  message: string;
  violations?: Violation[];
}

/** `GET /api/_a2app/whoami`. */
export interface Whoami {
  a2app: true;
  credentialId: string;
  agentName?: string | null;
  principal: string;
  scopes: string[];
}

/** `GET /api/_a2app/context`. */
export interface Context {
  a2app: true;
  view: string | null;
  selected: { entity: string; id: string }[];
}

/** Event envelope. */
export interface A2AppEvent {
  id: string;
  app: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type TaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

/** Task object. */
export interface Task {
  id: string;
  app: string;
  event?: string | null;
  status: TaskStatus;
  request: { capability: string; payload?: Record<string, unknown> };
  claim?: { credentialId: string; principal: string; claimedAt: string } | null;
  progress?: { step?: string | null; percent?: number | null };
  result?: Record<string, unknown> | null;
  reason?: string | null;
  createdAt: string;
  updatedAt: string;
  pollAfterMs?: number;
}

/** CLI/transport exit-code contract. */
export const EXIT = {
  OK: 0,
  REJECTED: 1,
  USAGE: 2,
  UNREACHABLE: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
