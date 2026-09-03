/**
 * Adapter-owned state: idempotency keys, the task queue, the event log,
 * grants/credentials, approval keys, and the audit log. Invisible to app code,
 * uniform across every adapter, so IAM and the queue behave identically on any
 * backend.
 *
 * Two implementations:
 *   - {@link InMemoryStateStore} — the fast default (resets on restart).
 *   - {@link FileStateStore} — persists every durable table to disk atomically,
 *     so the idempotency guarantee SURVIVES A RESTART (a restart is exactly when
 *     a retry arrives, so an in-memory idempotency store is non-conforming).
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:process";
import type { AuditEntry, Grant, EventTypeDecl } from "./types.js";

const IS_WINDOWS = platform === "win32";

/** Block the thread for `ms` — only used for the rare rename retry below, so the
 *  brief stall is acceptable and keeps the durable write fully synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `from` over `to`, retrying the Windows-transient failures. On win32 a
 * virus scanner or the indexer briefly locks a freshly-created temp file, so a
 * rename-over-existing intermittently throws EPERM/EACCES/EBUSY — fatal for a
 * write-temp-then-rename durable store unless retried. POSIX rename is atomic and
 * needs no retry, so this only loops for those codes.
 */
function durableRename(from: string, to: string): void {
  const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!IS_WINDOWS || !transient.has(code) || attempt >= maxAttempts) throw e;
      sleepSync(Math.min(50, attempt * 5)); // brief, increasing backoff
    }
  }
}

export interface IdempotencyRecord {
  recordId: string;
  at: number;
}

export interface StoredTask {
  id: string;
  app: string;
  event: string | null;
  status: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
  request: { capability: string; payload?: Record<string, unknown> };
  claim: { credentialId: string; principal: string; claimedAt: string } | null;
  progress: { step: string | null; percent: number | null };
  result: Record<string, unknown> | null;
  reason: string | null;
  ask: unknown;
  createdAt: string;
  updatedAt: string;
  dedupKey: string | null;
  deliveries: number;
}

export interface StoredEvent {
  seq: number;
  id: string;
  app: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** The pluggable state contract. */
export interface StateStore {
  grantByToken(token: string): Grant | null;
  grantByCredentialId(id: string): Grant | null;
  putGrant(grant: Grant): void;
  revoke(credentialId: string): void;

  idempotencyGet(entity: string, key: string): IdempotencyRecord | null;
  idempotencyPut(entity: string, key: string, recordId: string): void;

  approvalIssue(key: string): void;
  approvalConsume(key: string): boolean;

  appendEvent(type: string, payload: Record<string, unknown>): StoredEvent;
  eventsSince(cursor: string | null): { events: StoredEvent[]; nextCursor: string };

  enqueueTask(input: {
    event: string | null;
    capability: string;
    payload?: Record<string, unknown>;
    dedupKey?: string | null;
  }): StoredTask;
  getTask(id: string): StoredTask | null;
  listTasks(status?: string): StoredTask[];
  saveTask(task: StoredTask): void;
  sweep(timeoutMs: number, maxDeliveries: number): void;

  appendAudit(entry: AuditEntry): void;
  auditTail(n: number): AuditEntry[];
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // at least 24h
const APPROVAL_TTL_MS = 10 * 60 * 1000; // keys expire
/** Bound the retained tables so memory and the on-disk snapshot cannot grow
 *  without limit (an event log is otherwise append-forever). Both are rings:
 *  oldest rows fall off the back. `seq` stays monotonic so event cursors keep
 *  working across a prune. */
const EVENT_RETENTION = 5000;
const AUDIT_RETENTION = 5000;

function id(prefix: string): string {
  return prefix + "_" + randomBytes(8).toString("hex");
}

/** The serialisable snapshot of a store's durable tables. */
interface Snapshot {
  grants: Grant[];
  idem: Array<[string, IdempotencyRecord]>;
  approvals: Array<[string, number]>;
  events: StoredEvent[];
  seq: number;
  tasks: StoredTask[];
  dedup: Array<[string, string]>;
  audit: AuditEntry[];
}

export class InMemoryStateStore implements StateStore {
  protected grantsByToken = new Map<string, Grant>();
  protected grantsById = new Map<string, Grant>();
  protected idem = new Map<string, IdempotencyRecord>();
  protected approvals = new Map<string, number>();
  protected events: StoredEvent[] = [];
  protected seq = 0;
  protected tasks = new Map<string, StoredTask>();
  protected dedup = new Map<string, string>();
  protected audit: AuditEntry[] = [];
  protected readonly app: string;
  protected readonly clock: () => number;

  constructor(app: string, clock: () => number = () => Date.now()) {
    this.app = app;
    this.clock = clock;
  }

  /** Called after every mutation. Overridden by {@link FileStateStore} to
   *  persist; a no-op in memory. */
  protected onChange(): void {}

  protected serialize(): Snapshot {
    return {
      grants: [...this.grantsById.values()],
      idem: [...this.idem.entries()],
      approvals: [...this.approvals.entries()],
      events: this.events,
      seq: this.seq,
      tasks: [...this.tasks.values()],
      dedup: [...this.dedup.entries()],
      audit: this.audit,
    };
  }

  protected hydrate(s: Snapshot): void {
    for (const g of s.grants ?? []) {
      this.grantsByToken.set(g.token, g);
      this.grantsById.set(g.credentialId, g);
    }
    this.idem = new Map(s.idem ?? []);
    this.approvals = new Map(s.approvals ?? []);
    this.events = s.events ?? [];
    this.seq = s.seq ?? 0;
    for (const t of s.tasks ?? []) this.tasks.set(t.id, t);
    this.dedup = new Map(s.dedup ?? []);
    this.audit = s.audit ?? [];
  }

  /* -------------------------------------------------------------- grants */

  grantByToken(token: string): Grant | null {
    return this.grantsByToken.get(token) ?? null;
  }
  grantByCredentialId(cid: string): Grant | null {
    return this.grantsById.get(cid) ?? null;
  }
  putGrant(grant: Grant): void {
    this.grantsByToken.set(grant.token, grant);
    this.grantsById.set(grant.credentialId, grant);
    this.onChange();
  }
  revoke(credentialId: string): void {
    const g = this.grantsById.get(credentialId);
    if (!g) return;
    this.grantsById.delete(credentialId);
    this.grantsByToken.delete(g.token);
    this.onChange();
  }

  /* --------------------------------------------------------- idempotency */

  private idemKey(entity: string, key: string): string {
    return entity + " " + key;
  }
  idempotencyGet(entity: string, key: string): IdempotencyRecord | null {
    const rec = this.idem.get(this.idemKey(entity, key));
    if (!rec) return null;
    if (this.clock() - rec.at > IDEMPOTENCY_TTL_MS) {
      this.idem.delete(this.idemKey(entity, key));
      this.onChange();
      return null;
    }
    return rec;
  }
  idempotencyPut(entity: string, key: string, recordId: string): void {
    this.idem.set(this.idemKey(entity, key), { recordId, at: this.clock() });
    this.onChange();
  }

  /* ------------------------------------------------------------ approvals */

  approvalIssue(key: string): void {
    this.approvals.set(key, this.clock() + APPROVAL_TTL_MS);
    this.onChange();
  }
  approvalConsume(key: string): boolean {
    const exp = this.approvals.get(key);
    if (exp === undefined) return false;
    this.approvals.delete(key);
    this.onChange();
    return exp >= this.clock();
  }

  /* ------------------------------------------------------------- events */

  appendEvent(type: string, payload: Record<string, unknown>): StoredEvent {
    const ev: StoredEvent = {
      seq: ++this.seq,
      id: id("evt"),
      app: this.app,
      type,
      payload,
      createdAt: new Date(this.clock()).toISOString(),
    };
    this.events.push(ev);
    if (this.events.length > EVENT_RETENTION) this.events.splice(0, this.events.length - EVENT_RETENTION);
    this.onChange();
    return ev;
  }
  eventsSince(cursor: string | null): { events: StoredEvent[]; nextCursor: string } {
    const from = cursor ? Number(cursor) || 0 : 0;
    const events = this.events.filter((e) => e.seq > from);
    const nextCursor = String(events.length ? events[events.length - 1]!.seq : from);
    return { events, nextCursor };
  }

  /* -------------------------------------------------------------- tasks */

  enqueueTask(input: {
    event: string | null;
    capability: string;
    payload?: Record<string, unknown>;
    dedupKey?: string | null;
  }): StoredTask {
    if (input.dedupKey) {
      const existing = this.dedup.get(input.dedupKey);
      if (existing) {
        const t = this.tasks.get(existing);
        if (t) return t;
      }
    }
    const nowIso = new Date(this.clock()).toISOString();
    const task: StoredTask = {
      id: id("tsk"),
      app: this.app,
      event: input.event,
      status: "submitted",
      request: input.payload === undefined ? { capability: input.capability } : { capability: input.capability, payload: input.payload },
      claim: null,
      progress: { step: null, percent: 0 },
      result: null,
      reason: null,
      ask: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      dedupKey: input.dedupKey ?? null,
      deliveries: 1,
    };
    this.tasks.set(task.id, task);
    if (input.dedupKey) this.dedup.set(input.dedupKey, task.id);
    this.onChange();
    return task;
  }
  getTask(taskId: string): StoredTask | null {
    return this.tasks.get(taskId) ?? null;
  }
  listTasks(status?: string): StoredTask[] {
    const all = [...this.tasks.values()];
    return status ? all.filter((t) => t.status === status) : all;
  }
  saveTask(task: StoredTask): void {
    task.updatedAt = new Date(this.clock()).toISOString();
    this.tasks.set(task.id, task);
    this.onChange();
  }
  sweep(timeoutMs: number, maxDeliveries: number): void {
    const now = this.clock();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.status !== "working") continue;
      const updated = Date.parse(task.updatedAt);
      if (now - updated < timeoutMs) continue;
      if (task.deliveries >= maxDeliveries) {
        task.status = "failed";
        task.reason = "redelivery_exhausted";
      } else {
        task.status = "submitted";
        task.claim = null;
        task.deliveries += 1;
      }
      task.updatedAt = new Date(now).toISOString();
      changed = true;
    }
    if (changed) this.onChange();
  }

  /* -------------------------------------------------------------- audit */

  appendAudit(entry: AuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > AUDIT_RETENTION) this.audit.splice(0, this.audit.length - AUDIT_RETENTION);
    this.onChange();
  }
  auditTail(n: number): AuditEntry[] {
    return this.audit.slice(-n);
  }
}

/**
 * A file-backed store. Every mutation is flushed to `path` with an atomic write
 * (temp file + rename), so a restart re-reads the same idempotency keys, tasks,
 * events, grants, and audit. Suitable for single-process apps (the reference
 * deployment form); a multi-process deployment would back {@link StateStore}
 * with its DB.
 */
export class FileStateStore extends InMemoryStateStore {
  private readonly path: string;
  private loaded = false;

  constructor(path: string, app: string, clock: () => number = () => Date.now()) {
    super(app, clock);
    this.path = path;
    if (existsSync(path)) {
      try {
        this.hydrate(JSON.parse(readFileSync(path, "utf8")) as Snapshot);
      } catch {
        /* corrupt snapshot → start clean rather than crash the app */
      }
    }
    this.loaded = true;
    this.onChange(); // ensure the file exists from first boot
  }

  protected override onChange(): void {
    if (!this.loaded) return; // don't flush mid-hydrate
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = this.path + ".tmp";
    const payload = JSON.stringify(this.serialize());
    // Atomic AND durable: write the temp file, fsync it so the bytes are on the
    // platter (not just in the page cache), then rename over the target. Without
    // the fsync a crash right after rename can leave a zero-length or truncated
    // snapshot — and a restart is exactly when a retried write arrives, so a lost
    // idempotency table is a correctness bug, not just a performance one.
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    durableRename(tmp, this.path);
    // Best-effort directory fsync so the rename itself is durable on crash.
    // Windows has no directory-fsync (and opening a directory handle can lock
    // renames within it), so this is POSIX-only; the file fsync above still holds.
    if (!IS_WINDOWS) {
      try {
        const dfd = openSync(dir, "r");
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch {
        /* directory fsync unsupported here — non-fatal */
      }
    }
  }
}

export function newCredentialId(): string {
  return id("cred");
}

export function knownEventTypes(decls: EventTypeDecl[] | undefined): Set<string> {
  return new Set((decls ?? []).map((d) => d.type));
}
