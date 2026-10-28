/**
 * Device-code sign-in for agents (spec/v0_2/auth.md §7, RFC 8628 shape):
 *
 *   POST /api/_a2app/auth/device               an agent asks; gets a code to show
 *   GET  /api/_a2app/auth/device/{userCode}     the person reviews (a manager)
 *   POST /api/_a2app/auth/device/{userCode}     the person approves or denies
 *   POST /api/_a2app/auth/token                 the agent polls; gets its credential
 *
 * The person approves on the app's own account page, signed in as themselves;
 * the credential issued acts for them, with the scopes they approved. No
 * password or session ever reaches the agent. Codes live 10 minutes, are
 * single use, and the device code is stored only as its hash.
 *
 * Approving is not enough on its own: anyone can start a request and send the
 * person its link. So approval issues a one-time confirmation code, and the
 * credential goes only to whoever presents it. An agent on the person's own
 * computer receives it on a loopback port (RFC 8252) when the page returns the
 * browser there; an agent elsewhere is given it by the person.
 */
import { hashSecret, newSecret, newUserCode, normalizeUserCode } from "./auth.js";
import { ACCOUNT_URL, type Manager } from "./accounts.js";
import { credentialWire, mintCredential, parseGrantRequest } from "./credentials.js";
import type { StateStore } from "./store.js";
import type { A2AppReply, A2AppRequest, PrincipalInfo } from "./types.js";

const CODE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_STEP_SECONDS = 5;
/** Wrong confirmation codes a request survives before it is void. */
const CONFIRM_ATTEMPTS = 5;
/** Where an agent on the person's computer waits for the confirmation. */
const LOOPBACK_CALLBACK = "/a2app/callback";
const LOOPBACK_PORT_MIN = 1024;
const LOOPBACK_PORT_MAX = 65535;

interface DeviceRow {
  userCode: string;
  agentName: string | null;
  /** what the agent asked for */
  scopes: string[];
  /** the issued credential's lifetime */
  expiresInSeconds: number;
  createdAt: string;
  /** when the codes stop working */
  expiresAt: string;
  interval: number;
  lastPolledAt: number | null;
  status: "pending" | "approved" | "denied";
  approvedBy: string | null;
  approvedScopes: string[] | null;
  /** the 127.0.0.1 port the agent waits on, when it is on the person's computer */
  loopbackPort: number | null;
  /** SHA-256 of the confirmation code issued at approval */
  confirmationHash: string | null;
  confirmAttempts: number;
}

export interface DeviceDeps {
  store: StateStore;
  now: () => Date;
  ok: (json: unknown, status?: number) => A2AppReply;
  err: (status: number, code: string, message: string, extra?: Record<string, unknown>) => A2AppReply;
  managerOf: (req: A2AppRequest, opts: { write: boolean }) => Manager | A2AppReply;
  principalInfo: (id: string) => PrincipalInfo | null;
  declaredScopes: () => Set<string>;
  publicOrigin: (req: A2AppRequest) => string;
}

export function createDeviceRoutes(deps: DeviceDeps) {
  const { store, ok, err } = deps;
  const nowMs = () => deps.now().getTime();

  /** Live rows by key, dropping the expired as it goes. */
  function liveRows(): Array<[string, DeviceRow]> {
    const t = nowMs();
    const rows = store.rows<DeviceRow>("devices");
    for (const [key, row] of rows) if (Date.parse(row.expiresAt) <= t) store.deleteRow("devices", key);
    return rows.filter(([, row]) => Date.parse(row.expiresAt) > t);
  }

  function byUserCode(input: string): [string, DeviceRow] | null {
    const code = normalizeUserCode(input);
    return code === "" ? null : (liveRows().find(([, row]) => row.userCode === code && row.status === "pending") ?? null);
  }

  function start(req: A2AppRequest): A2AppReply {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseGrantRequest(body, deps.declaredScopes());
    if ("problem" in parsed) return err(400, "usage", parsed.problem);
    const agentName = body.agentName;
    if (agentName !== undefined && (typeof agentName !== "string" || agentName.trim() === "" || agentName.length > 100)) {
      return err(400, "usage", "agentName is 1–100 characters.");
    }
    const loopbackPort = body.loopbackPort ?? null;
    if (
      loopbackPort !== null &&
      (typeof loopbackPort !== "number" || !Number.isInteger(loopbackPort) || loopbackPort < LOOPBACK_PORT_MIN || loopbackPort > LOOPBACK_PORT_MAX)
    ) {
      return err(400, "usage", `loopbackPort is the port, ${LOOPBACK_PORT_MIN} to ${LOOPBACK_PORT_MAX}, where the agent waits on 127.0.0.1.`);
    }
    const taken = new Set(liveRows().map(([, row]) => row.userCode));
    let userCode = newUserCode();
    while (taken.has(userCode)) userCode = newUserCode();
    const deviceCode = newSecret();
    const t = nowMs();
    store.putRow<DeviceRow>("devices", hashSecret(deviceCode), {
      userCode,
      agentName: typeof agentName === "string" ? agentName.trim() : null,
      scopes: parsed.scopes,
      expiresInSeconds: parsed.expiresInSeconds,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + CODE_TTL_SECONDS * 1000).toISOString(),
      interval: POLL_INTERVAL_SECONDS,
      lastPolledAt: null,
      status: "pending",
      approvedBy: null,
      approvedScopes: null,
      loopbackPort,
      confirmationHash: null,
      confirmAttempts: 0,
    });
    const approve = `${deps.publicOrigin(req)}${ACCOUNT_URL}#approve`;
    return ok({
      a2app: true,
      deviceCode,
      userCode,
      verificationUri: approve,
      verificationUriComplete: `${approve}/${userCode}`,
      expiresIn: CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    });
  }

  function poll(req: A2AppRequest): A2AppReply {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceCode = body.deviceCode;
    if (typeof deviceCode !== "string") return err(400, "usage", "Poll with { deviceCode }.");
    const key = hashSecret(deviceCode);
    const row = store.row<DeviceRow>("devices", key);
    const t = nowMs();
    if (!row || Date.parse(row.expiresAt) <= t) {
      if (row) store.deleteRow("devices", key);
      return err(400, "expired_token", "This sign-in request expired or was already used. Start again.");
    }
    if (row.status === "denied") {
      store.deleteRow("devices", key);
      return err(400, "access_denied", "The person declined this agent's request.");
    }
    if (row.status === "approved" && row.approvedBy !== null && row.approvedScopes !== null && row.confirmationHash !== null) {
      // Answered at once, whatever the interval: wrong guesses are bounded by
      // CONFIRM_ATTEMPTS instead.
      const confirmation = typeof body.confirmation === "string" ? normalizeUserCode(body.confirmation) : "";
      if (confirmation === "") {
        return err(400, "confirmation_required", "Approved. Present the confirmation code the approval produced.", { interval: row.interval });
      }
      if (hashSecret(confirmation) !== row.confirmationHash) {
        const attempts = row.confirmAttempts + 1;
        if (attempts >= CONFIRM_ATTEMPTS) {
          store.deleteRow("devices", key);
          return err(400, "access_denied", "Too many wrong confirmation codes: this request is void. Start again.");
        }
        store.putRow<DeviceRow>("devices", key, { ...row, confirmAttempts: attempts });
        return err(400, "confirmation_invalid", `That is not this request's confirmation code (${CONFIRM_ATTEMPTS - attempts} tries left).`);
      }
      // Single use: the row goes before the credential is handed out.
      store.deleteRow("devices", key);
      const info = deps.principalInfo(row.approvedBy);
      if (!info || !info.active) return err(400, "access_denied", "The person who approved this is no longer active.");
      const { token, grant } = mintCredential(store, deps.now(), {
        principal: row.approvedBy,
        agentName: row.agentName,
        scopes: row.approvedScopes,
        expiresInSeconds: row.expiresInSeconds,
      });
      return ok({ a2app: true, token, credential: credentialWire(grant, info.name) });
    }
    if (row.lastPolledAt !== null && t - row.lastPolledAt < row.interval * 1000) {
      const interval = row.interval + SLOW_DOWN_STEP_SECONDS;
      store.putRow<DeviceRow>("devices", key, { ...row, interval, lastPolledAt: t });
      return err(400, "slow_down", `Polling too fast: wait ${interval} s between polls.`, { interval });
    }
    store.putRow<DeviceRow>("devices", key, { ...row, lastPolledAt: t });
    return err(400, "authorization_pending", "Waiting for the person to approve.", { interval: row.interval });
  }

  function review(req: A2AppRequest, userCode: string): A2AppReply {
    const manager = deps.managerOf(req, { write: false });
    if ("status" in manager) return manager;
    const found = byUserCode(userCode);
    if (!found) return err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.");
    const [, row] = found;
    return ok({
      a2app: true,
      userCode: row.userCode,
      agentName: row.agentName,
      scopes: row.scopes,
      expiresIn: row.expiresInSeconds,
      expiresAt: row.expiresAt,
      requestedAt: row.createdAt,
      loopback: row.loopbackPort !== null,
    });
  }

  function decide(req: A2AppRequest, userCode: string): A2AppReply {
    const manager = deps.managerOf(req, { write: true });
    if ("status" in manager) return manager;
    const found = byUserCode(userCode);
    if (!found) return err(404, "device_code_invalid", "No sign-in request with that code is waiting: it was used, or it expired.");
    const [key, row] = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.approve !== "boolean") return err(400, "usage", "Decide with { approve: true | false }.");
    if (!body.approve) {
      store.putRow<DeviceRow>("devices", key, { ...row, status: "denied" });
      return ok({ a2app: true, ok: true, status: "denied" });
    }
    // The person may only narrow what was asked for.
    let scopes = row.scopes;
    if (body.scopes !== undefined) {
      const parsed = parseGrantRequest({ scopes: body.scopes }, deps.declaredScopes());
      if ("problem" in parsed) return err(400, "usage", parsed.problem);
      const asked = row.scopes.includes("*") ? null : new Set(row.scopes);
      const wider = asked === null ? [] : parsed.scopes.filter((s) => s === "*" || !asked.has(s));
      if (wider.length > 0) return err(400, "usage", `Approval can only narrow what the agent asked for, not add ${wider.join(", ")}.`);
      scopes = parsed.scopes;
    }
    const confirmation = newUserCode();
    store.putRow<DeviceRow>("devices", key, {
      ...row,
      status: "approved",
      approvedBy: manager.principal,
      approvedScopes: scopes,
      confirmationHash: hashSecret(confirmation),
    });
    return ok({
      a2app: true,
      ok: true,
      status: "approved",
      confirmation,
      redirect:
        row.loopbackPort === null
          ? null
          : `http://127.0.0.1:${row.loopbackPort}${LOOPBACK_CALLBACK}?confirmation=${encodeURIComponent(confirmation)}`,
    });
  }

  /** Route one request under /api/_a2app/auth/, or null. */
  return function handle(req: A2AppRequest, path: string): A2AppReply | null {
    if (path === "/api/_a2app/auth/device") {
      return req.method === "POST" ? start(req) : err(405, "usage", "Start a sign-in with POST.");
    }
    if (path === "/api/_a2app/auth/token") {
      return req.method === "POST" ? poll(req) : err(405, "usage", "Poll with POST.");
    }
    if (path.startsWith("/api/_a2app/auth/device/")) {
      const code = decodeURIComponent(path.slice("/api/_a2app/auth/device/".length));
      if (req.method === "GET") return review(req, code);
      if (req.method === "POST") return decide(req, code);
      return err(405, "usage", `${req.method} not allowed on a sign-in request.`);
    }
    return null;
  };
}
