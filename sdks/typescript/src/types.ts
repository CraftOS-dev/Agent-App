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

export interface DescribeEntity {
  label: string | null;
  records: string;
  auth?: boolean;
  fields: Record<string, DescribeField>;
}

export interface OperationDecl {
  name: string;
  description?: string;
  destructive: boolean;
  readOnly?: boolean;
  idempotent?: boolean;
  params?: Record<string, unknown>;
}

/** `GET /api/_a2app/describe`. */
export interface Describe {
  entities: Record<string, DescribeEntity>;
  operations: OperationDecl[];
  conventions: Record<string, unknown>;
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
