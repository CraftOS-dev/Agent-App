/**
 * Accounts, sessions and invites on a multi-user app (spec/v0_2/auth.md §4):
 *
 *   GET/POST/DELETE /api/_a2app/session        who is signed in · sign in · sign out
 *   POST /api/_a2app/invites                    a one-time setup link (owner manager)
 *   GET/POST /api/_a2app/invites/{code}         read · accept (creates the account)
 *   GET /api/_a2app/users                       every account (owner manager)
 *   PATCH /api/_a2app/users/{id}                activate/deactivate, change role
 *
 * Accounts are adapter state, never records: they are not served by the records
 * API, and a password hash never leaves this module.
 */
import {
  FailureLimiter,
  hashPassword,
  hashSecret,
  newId,
  newSecret,
  normalizeLogin,
  PASSWORD_MAX,
  PASSWORD_MIN,
  sessionCookie,
  verifyPassword,
  type AccountRow,
  type InviteRow,
  type Role,
  type SessionRow,
} from "./auth.js";
import type { StateStore } from "./store.js";
import type { A2AppReply, A2AppRequest } from "./types.js";

export const ACCOUNT_URL = "/_a2app/account";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SIGN_IN_FAILURES = 10;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 254;
const NAME_MAX = 100;

/** Who may manage this app's accounts and credentials (§2.4). */
export interface Manager {
  principal: string;
  role: Role;
}

export interface AccountDeps {
  store: StateStore;
  now: () => Date;
  ok: (json: unknown, status?: number, headers?: Record<string, string>) => A2AppReply;
  err: (status: number, code: string, message: string, extra?: Record<string, unknown>) => A2AppReply;
  /** The caller as a manager, or the refusal to send. `write` applies the
   *  same-origin rule to a signed-in change. */
  managerOf: (req: A2AppRequest, opts: { write: boolean }) => Manager | A2AppReply;
  /** The signed-in account behind this request's session cookie, if any. */
  sessionOf: (req: A2AppRequest) => { key: string; account: AccountRow } | null;
  sessionCookieName: string;
  secureCookies: boolean;
  /** Where this app is reached, for links handed to a person. */
  publicOrigin: (req: A2AppRequest) => string;
  /** Whether a request came from a page of the app's own origin. */
  isSameOrigin: (req: A2AppRequest) => boolean;
}

/** The account as served: never its password hash. */
export function accountWire(a: AccountRow): Record<string, unknown> {
  return { id: a.id, name: a.name, login: a.login, role: a.role, active: a.active, createdAt: a.createdAt };
}

export function createAccountRoutes(deps: AccountDeps) {
  const { store, ok, err } = deps;
  const nowMs = () => deps.now().getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const signInFailures = new FailureLimiter(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS, nowMs);
  // Checked against when a login does not exist, so a missing account takes
  // as long to refuse as a wrong password and the timing does not say which.
  let dummyHash: Promise<string> | null = null;

  const accounts = () => store.rows<AccountRow>("users").map(([, a]) => a);
  const byLogin = (login: string) => accounts().find((a) => a.login === login) ?? null;

  function startSession(account: AccountRow, status: number): A2AppReply {
    const secret = newSecret();
    const createdAt = nowMs();
    store.putRow<SessionRow>("sessions", hashSecret(secret), {
      principal: account.id,
      createdAt: iso(createdAt),
      expiresAt: iso(createdAt + SESSION_TTL_MS),
    });
    return ok({ a2app: true, ...accountWire(account) }, status, {
      "set-cookie": sessionCookie(deps.sessionCookieName, secret, {
        maxAgeSeconds: SESSION_TTL_MS / 1000,
        secure: deps.secureCookies,
      }),
    });
  }

  /** The reason `body` is not a valid new account, or null. */
  function accountProblem(body: Record<string, unknown>): string | null {
    const { name, login, password } = body;
    if (typeof name !== "string" || name.trim() === "" || name.trim().length > NAME_MAX) {
      return `name must be 1–${NAME_MAX} characters.`;
    }
    if (typeof login !== "string" || normalizeLogin(login) === "" || normalizeLogin(login).length > LOGIN_MAX) {
      return `login must be 1–${LOGIN_MAX} characters.`;
    }
    if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return `password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`;
    }
    return null;
  }

  function liveInvite(code: string): { key: string; invite: InviteRow } | null {
    const key = hashSecret(code);
    const invite = store.row<InviteRow>("invites", key);
    if (!invite) return null;
    if (Date.parse(invite.expiresAt) <= nowMs()) {
      store.deleteRow("invites", key);
      return null;
    }
    return { key, invite };
  }

  const activeOwners = () => accounts().filter((a) => a.role === "owner" && a.active);

  async function handleSession(req: A2AppRequest): Promise<A2AppReply> {
    if (req.method === "GET") {
      const session = deps.sessionOf(req);
      if (!session) return err(401, "sign_in_required", "Not signed in.", { signInUrl: `${ACCOUNT_URL}#sign-in` });
      return ok({ a2app: true, ...accountWire(session.account) });
    }
    if (req.method === "DELETE") {
      const session = deps.sessionOf(req);
      if (session) store.deleteRow("sessions", session.key);
      return ok({ a2app: true, ok: true }, 200, {
        "set-cookie": sessionCookie(deps.sessionCookieName, "", { maxAgeSeconds: 0, secure: deps.secureCookies }),
      });
    }
    if (req.method !== "POST") return err(405, "usage", `${req.method} not allowed on the session.`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.login !== "string" || typeof body.password !== "string") {
      return err(400, "usage", "Sign in with { login, password }.");
    }
    const login = normalizeLogin(body.login);
    const wait = signInFailures.retryAfter(login);
    if (wait > 0) {
      return err(429, "rate_limited", "Too many failed sign-ins for this login. Try again later.", { retryAfterSeconds: wait });
    }
    const account = byLogin(login);
    let matches: boolean;
    if (account) {
      matches = await verifyPassword(body.password, account.passwordHash);
    } else {
      dummyHash ??= hashPassword(newSecret());
      await verifyPassword(body.password, await dummyHash);
      matches = false;
    }
    if (!account || !matches || !account.active) {
      signInFailures.fail(login);
      return err(401, "sign_in_failed", "That login and password do not match an active account.");
    }
    signInFailures.reset(login);
    return startSession(account, 200);
  }

  async function handleInvites(req: A2AppRequest, code: string | null): Promise<A2AppReply> {
    if (code === null) {
      if (req.method !== "POST") return err(405, "usage", `${req.method} not allowed on invites.`);
      const manager = deps.managerOf(req, { write: true });
      if ("status" in manager) return manager;
      if (manager.role !== "owner") return err(403, "not_a_manager", "Only an owner can invite people.");
      const role = (req.body as Record<string, unknown> | undefined)?.role ?? "member";
      if (role !== "owner" && role !== "member") return err(400, "usage", 'role is "owner" or "member".');
      const secret = newSecret();
      const createdAt = nowMs();
      const invite: InviteRow = { role, createdAt: iso(createdAt), expiresAt: iso(createdAt + INVITE_TTL_MS) };
      store.putRow("invites", hashSecret(secret), invite);
      return ok(
        {
          a2app: true,
          code: secret,
          url: `${deps.publicOrigin(req)}${ACCOUNT_URL}#setup/${secret}`,
          role: invite.role,
          expiresAt: invite.expiresAt,
        },
        201,
      );
    }

    const found = liveInvite(code);
    if (!found) return err(404, "invite_invalid", "This invite link is not valid: it was used, or it expired.");
    if (req.method === "GET") return ok({ a2app: true, role: found.invite.role, expiresAt: found.invite.expiresAt });
    if (req.method !== "POST") return err(405, "usage", `${req.method} not allowed on an invite.`);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = accountProblem(body);
    if (problem) return err(400, "usage", problem);
    const login = normalizeLogin(body.login as string);
    if (byLogin(login)) return err(409, "login_taken", "That login is already in use.");
    const passwordHash = await hashPassword(body.password as string);
    // From here to the write there is no await, so the checks and the write
    // are one step: a second acceptance of the same invite, or a second account
    // racing for the same login, sees this one's result.
    const still = liveInvite(code);
    if (!still) return err(404, "invite_invalid", "This invite link is not valid: it was used, or it expired.");
    if (byLogin(login)) return err(409, "login_taken", "That login is already in use.");
    const account: AccountRow = {
      id: newId("usr"),
      name: (body.name as string).trim(),
      login,
      role: still.invite.role,
      active: true,
      createdAt: iso(nowMs()),
      passwordHash,
    };
    store.deleteRow("invites", still.key);
    store.putRow("users", account.id, account);
    return startSession(account, 201);
  }

  function handleUsers(req: A2AppRequest, id: string | null): A2AppReply {
    const manager = deps.managerOf(req, { write: req.method !== "GET" });
    if ("status" in manager) return manager;
    if (manager.role !== "owner") return err(403, "not_a_manager", "Only an owner can manage people.");

    if (id === null) {
      if (req.method !== "GET") return err(405, "usage", `${req.method} not allowed on users.`);
      const users = accounts()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(accountWire);
      return ok({ a2app: true, users });
    }
    if (req.method !== "PATCH") return err(405, "usage", `${req.method} not allowed on a user.`);
    const account = store.row<AccountRow>("users", id);
    if (!account) return err(404, "not_found", `No account "${id}".`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.active !== undefined && typeof body.active !== "boolean") return err(400, "usage", "active is true or false.");
    if (body.role !== undefined && body.role !== "owner" && body.role !== "member") {
      return err(400, "usage", 'role is "owner" or "member".');
    }
    const next: AccountRow = {
      ...account,
      ...(typeof body.active === "boolean" ? { active: body.active } : {}),
      ...(body.role === "owner" || body.role === "member" ? { role: body.role } : {}),
    };
    const losesOwner = account.role === "owner" && account.active && (next.role !== "owner" || !next.active);
    if (losesOwner && activeOwners().length === 1) {
      return err(409, "last_owner", "This is the last active owner. Make someone else an owner first.");
    }
    store.putRow("users", next.id, next);
    return ok({ a2app: true, ...accountWire(next) });
  }

  /** Route one request under /api/_a2app/{session,invites,users}, or null. */
  return async function handle(req: A2AppRequest, path: string): Promise<A2AppReply | null> {
    if (path === "/api/_a2app/session") return handleSession(req);
    if (path === "/api/_a2app/invites") return handleInvites(req, null);
    if (path.startsWith("/api/_a2app/invites/")) return handleInvites(req, decodeURIComponent(path.slice(20)));
    if (path === "/api/_a2app/users") return handleUsers(req, null);
    if (path.startsWith("/api/_a2app/users/")) return handleUsers(req, decodeURIComponent(path.slice(18)));
    return null;
  };
}
