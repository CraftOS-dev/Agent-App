/**
 * Delegated agent credentials (spec/v0_2/auth.md §2, §8):
 *
 *   GET /api/_a2app/credentials          a manager's own (an owner: everyone's)
 *   POST /api/_a2app/credentials         issue one; the token is in this reply only
 *   DELETE /api/_a2app/credentials/{id}  revoke (a manager, or the credential itself)
 *
 * Every credential this app issues is made by {@link mintCredential}: a 256-bit
 * token returned once, stored as its SHA-256, bound to one principal, always
 * expiring. Whatever its scopes say, each request it makes is limited to what
 * that principal may do at the time (server.ts, `credentialOf`).
 */
import { hashSecret, newId, newToken } from "./auth.js";
import type { Manager } from "./accounts.js";
import type { StateStore } from "./store.js";
import type { A2AppReply, A2AppRequest, Grant, PrincipalInfo } from "./types.js";

export const DEFAULT_EXPIRES_SECONDS = 30 * 24 * 60 * 60;
export const MIN_EXPIRES_SECONDS = 60;
export const MAX_EXPIRES_SECONDS = 365 * 24 * 60 * 60;

/** A credential as listed: never its token or the token's hash. */
export function credentialWire(g: Grant, principalName: string | null): Record<string, unknown> {
  return {
    credentialId: g.credentialId,
    principal: g.principal,
    principalName,
    agentName: g.agentName,
    scopes: g.scopes,
    createdAt: g.createdAt,
    expiresAt: g.expiresAt,
    lastUsedAt: g.lastUsedAt,
    task: g.task,
  };
}

export interface MintInput {
  principal: string;
  agentName: string | null;
  scopes: string[];
  expiresInSeconds: number;
  task?: string | null;
}

/** Issue a credential: store its hash, return the token (once) with the grant. */
export function mintCredential(store: StateStore, now: Date, input: MintInput): { token: string; grant: Grant } {
  const token = newToken();
  const grant: Grant = {
    credentialId: newId("cred"),
    tokenHash: hashSecret(token),
    principal: input.principal,
    agentName: input.agentName,
    scopes: input.scopes,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    task: input.task ?? null,
    admin: false,
  };
  store.putGrant(grant);
  return { token, grant };
}

/**
 * The scopes and lifetime a caller asked for, checked; or the reason they
 * cannot be granted. `scopes` defaults to `*`; every entry must be `*` or a
 * scope the app declares.
 */
export function parseGrantRequest(
  body: Record<string, unknown>,
  declared: Set<string>,
): { scopes: string[]; expiresInSeconds: number } | { problem: string } {
  const scopes = body.scopes ?? ["*"];
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
    return { problem: "scopes is a non-empty list of scope names (or [\"*\"])." };
  }
  const unknown = (scopes as string[]).filter((s) => s !== "*" && !declared.has(s));
  if (unknown.length > 0) return { problem: `Not scopes this app declares: ${unknown.join(", ")}.` };
  const expiresIn = body.expiresIn ?? DEFAULT_EXPIRES_SECONDS;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < MIN_EXPIRES_SECONDS || expiresIn > MAX_EXPIRES_SECONDS) {
    return { problem: `expiresIn is a whole number of seconds from ${MIN_EXPIRES_SECONDS} to ${MAX_EXPIRES_SECONDS} (365 days).` };
  }
  return { scopes: [...new Set(scopes as string[])], expiresInSeconds: expiresIn };
}

export interface CredentialDeps {
  store: StateStore;
  now: () => Date;
  ok: (json: unknown, status?: number, headers?: Record<string, string>) => A2AppReply;
  err: (status: number, code: string, message: string, extra?: Record<string, unknown>) => A2AppReply;
  managerOf: (req: A2AppRequest, opts: { write: boolean }) => Manager | A2AppReply;
  /** The credential this request presents, if it is a usable one. */
  presentedGrant: (req: A2AppRequest) => Grant | null;
  principalInfo: (id: string) => PrincipalInfo | null;
  /** Every scope the app declares. */
  declaredScopes: () => Set<string>;
}

export function createCredentialRoutes(deps: CredentialDeps) {
  const { store, ok, err } = deps;
  const nameOf = (principal: string) => deps.principalInfo(principal)?.name ?? null;

  /** Still able to make a request: not revoked, not expired, its task not over. */
  function live(g: Grant): boolean {
    if (g.admin || g.revokedAt !== null) return false;
    if (g.expiresAt !== null && Date.parse(g.expiresAt) <= deps.now().getTime()) return false;
    if (g.task !== null) {
      const task = store.getTask(g.task);
      if (!task || task.status === "completed" || task.status === "failed" || task.status === "canceled") return false;
    }
    return true;
  }

  function list(req: A2AppRequest): A2AppReply {
    const manager = deps.managerOf(req, { write: false });
    if ("status" in manager) return manager;
    const credentials = store
      .listGrants()
      .filter((g) => live(g) && (manager.role === "owner" || g.principal === manager.principal))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((g) => credentialWire(g, nameOf(g.principal)));
    return ok({ a2app: true, credentials });
  }

  function issue(req: A2AppRequest): A2AppReply {
    const manager = deps.managerOf(req, { write: true });
    if ("status" in manager) return manager;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const principal = body.principal ?? manager.principal;
    if (typeof principal !== "string") return err(400, "usage", "principal is an account id (or \"owner\").");
    if (principal !== manager.principal && manager.role !== "owner") {
      return err(403, "not_a_manager", "Only an owner can issue a credential for someone else.");
    }
    const info = deps.principalInfo(principal);
    if (!info || !info.active) return err(400, "usage", `"${principal}" is not an active account of this app.`);
    if (body.agentName !== undefined && (typeof body.agentName !== "string" || body.agentName.trim() === "" || body.agentName.length > 100)) {
      return err(400, "usage", "agentName is 1–100 characters.");
    }
    const parsed = parseGrantRequest(body, deps.declaredScopes());
    if ("problem" in parsed) return err(400, "usage", parsed.problem);
    const { token, grant } = mintCredential(store, deps.now(), {
      principal,
      agentName: typeof body.agentName === "string" ? body.agentName.trim() : null,
      scopes: parsed.scopes,
      expiresInSeconds: parsed.expiresInSeconds,
    });
    return ok({ a2app: true, token, credential: credentialWire(grant, info.name) }, 201);
  }

  function revoke(req: A2AppRequest, id: string): A2AppReply {
    const grant = store.grantById(id);
    if (!grant) return err(404, "not_found", `No credential "${id}".`);
    if (grant.admin) return err(403, "not_a_manager", "The admin credential is the app's .agent-token: rotate that file instead.");
    // A credential may always revoke itself — the one thing an agent may do
    // with credentials — so an agent can hand back access it no longer needs.
    const self = deps.presentedGrant(req)?.credentialId === id;
    if (!self) {
      const manager = deps.managerOf(req, { write: true });
      if ("status" in manager) return manager;
      if (manager.role !== "owner" && grant.principal !== manager.principal) {
        return err(404, "not_found", `No credential "${id}".`);
      }
    }
    if (grant.revokedAt === null) store.putGrant({ ...grant, revokedAt: deps.now().toISOString() });
    return ok({ a2app: true, ok: true, revoked: id });
  }

  /** Route one request under /api/_a2app/credentials, or null. */
  return function handle(req: A2AppRequest, path: string): A2AppReply | null {
    if (path === "/api/_a2app/credentials") {
      if (req.method === "GET") return list(req);
      if (req.method === "POST") return issue(req);
      return err(405, "usage", `${req.method} not allowed on credentials.`);
    }
    if (path.startsWith("/api/_a2app/credentials/")) {
      if (req.method !== "DELETE") return err(405, "usage", "A credential is revoked with DELETE.");
      return revoke(req, decodeURIComponent(path.slice("/api/_a2app/credentials/".length)));
    }
    return null;
  };
}
