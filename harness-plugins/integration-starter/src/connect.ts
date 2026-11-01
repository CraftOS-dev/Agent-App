/**
 * Connect: an Agent App that runs on another machine, used from a manager tab.
 *
 * A manager signs the harness's agent in to the app (`a2app <url> login`) and
 * shows the app in a tab of its own. Where the manager page may embed the app,
 * that tab shows the app's approval page: the person signs in there as
 * themselves and approves, the page hands the confirmation code back, and the
 * sign-in finishes with it (`login --confirm`). Elsewhere the approval opens in
 * the browser. The routes, independent of how a harness serves HTTP:
 *
 *   POST /connect  { url, here?, embed? }     starts the sign-in: { job }
 *   GET  /connect?job=<id>                    the job: the approval link and code, then how it ended
 *   POST /connect/confirm  { url, code }      finishes with the code the approval page gave
 *   POST /app/disconnect   { path }           revokes the agent's credential and forgets the app
 *
 * A connected app is listed by `agent-app list` under `connected`; `remoteRows`
 * turns those into manager rows, keyed by the app's origin, which is also how
 * the CLI addresses it.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import { runA2App, type CliResult } from "./cli.js";
import { failureOf, type ApiReply } from "./packages.js";
import { parseKnownApps, type KnownApp } from "./apps.js";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * The origin of an app address a person typed: `https://crm.example.com/x`, or a
 * bare `crm.example.com` (https assumed). Null for anything that is not an
 * http(s) address: the CLI would read it as a folder or an app name here.
 */
export function appOrigin(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!host.startsWith("[") && !HOSTNAME.test(host)) return null; // not a host name: a path or a phrase
  return url.origin;
}

/**
 * An app's name in a harness's session keys: its folder's name, or for a
 * connected app (its path is its origin) its host, in characters any key
 * takes: `crm.example.com`, `127.0.0.1-8191`.
 */
export function appSessionName(path: string): string {
  return appOrigin(path) === path ? new URL(path).host.replace(/[^A-Za-z0-9.-]/g, "-") : basename(path);
}

/** How an app lists the credential this harness's agent gets: "<Harness> on <machine>". */
export function connectAgentName(harness: string): string {
  return `${harness} on ${hostname()}`;
}

/**
 * `a2app <origin> login`, followed as JSON lines. With the person's browser on
 * this computer the code comes back to the CLI's loopback port (`--print-only`:
 * the page opens the link itself); otherwise the person, or the page that
 * embeds the approval, gives the code back (`--no-browser`).
 */
export function loginArgv(origin: string, browserHere: boolean, agentName: string): string[] {
  return [origin, "login", "--name", agentName, "--events", browserHere ? "--print-only" : "--no-browser"];
}

/** One stdout line of `login --events`. */
export type LoginEvent =
  | { event: "approve"; url: string; userCode: string; [key: string]: unknown }
  | { event: "result"; ok: boolean; [key: string]: unknown };

/** Parse one line of `login --events`: `approve` (the link and the code), or `result`; null for anything else. */
export function parseLoginEvent(line: string): LoginEvent | null {
  const text = line.trim();
  if (!text.startsWith("{")) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.event === "approve" && typeof d.url === "string" && typeof d.userCode === "string") return d as LoginEvent;
  if (d.event === "result" && typeof d.ok === "boolean") return d as LoginEvent;
  return null;
}

/** An app on another machine this one holds a credential for, as `agent-app list --json` reports it. */
export interface ConnectedApp {
  origin: string;
  appId: string | null;
  name: string;
  principalName: string | null;
  expiresAt: string | null;
  status: "online" | "offline" | "unreachable" | "expired";
}

const STATUSES = new Set(["online", "offline", "unreachable", "expired"]);

/** The `connected` array of `agent-app list --json`. Tolerant, like parseKnownApps. */
export function parseConnectedApps(result: CliResult): ConnectedApp[] {
  const doc = result.json as { connected?: unknown } | null;
  const rows = doc && Array.isArray(doc.connected) ? doc.connected : [];
  return rows.flatMap((r) => {
    const a = r as Record<string, unknown>;
    if (typeof a.origin !== "string" || appOrigin(a.origin) !== a.origin) return [];
    const text = (key: string): string | null => (typeof a[key] === "string" ? (a[key] as string) : null);
    return [{
      origin: a.origin,
      appId: text("appId"),
      name: text("name") ?? a.origin,
      principalName: text("principalName") ?? text("principal"),
      expiresAt: text("expiresAt"),
      status: (STATUSES.has(a.status as string) ? a.status : "offline") as ConnectedApp["status"],
    }];
  });
}

/** This machine's apps and the connected ones, from one `agent-app list --json`. */
export async function listApps(frameworkBin = "agent-app"): Promise<{ apps: KnownApp[]; connected: ConnectedApp[] }> {
  const r = await runA2App(frameworkBin, ["list", "--json"]);
  return { apps: parseKnownApps(r), connected: parseConnectedApps(r) };
}

/** A manager row for a connected app: keyed (`path`) by its origin. */
export interface RemoteRow {
  id: string;
  name: string;
  path: string;
  url: string;
  remote: true;
  status: ConnectedApp["status"];
  principalName: string | null;
  expiresAt: string | null;
  /** whether the manager page may embed it; else `embedHint` says what to change */
  embeddable: boolean;
  embedHint: string | null;
  building: false;
  buildEnded: false;
}

/** One sign-in a manager started, as its polls see it. */
export interface ConnectJob {
  id: string;
  origin: string;
  /** the approval link and the code to check, as soon as the CLI says them */
  approve: Record<string, unknown> | null;
  done: boolean;
  ok: boolean;
  /** signed in once the confirmation code is given (`POST /connect/confirm`) */
  pending: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  /** the page shows the approval page itself, in the app's tab */
  embedded: boolean;
  /** why it cannot, when it cannot */
  embedHint: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ConnectOptions {
  /** How the app lists the agent's credential (default: "Agent on <machine>"). */
  agentName?: string;
  /**
   * Whether the manager page may embed `origin`: null when it may, else what to
   * change so it can. Default: it may (a host whose page frames anything).
   */
  framePolicy?: (origin: string) => string | null;
}

/**
 * The connect routes of a manager tab. Each method takes what the route
 * received and returns the reply to send.
 */
export class ConnectApi {
  private readonly jobs = new Map<string, ConnectJob>();
  private readonly agentName: string;
  private readonly framePolicy: (origin: string) => string | null;

  constructor(
    private readonly cliBin: string,
    private readonly frameworkBin: string,
    opts: ConnectOptions = {},
    private readonly keepMs = 60 * 60 * 1000,
  ) {
    this.agentName = opts.agentName ?? connectAgentName("Agent");
    this.framePolicy = opts.framePolicy ?? (() => null);
  }

  /** Rows for the manager's tab strip, after this machine's apps. */
  remoteRows(connected: ConnectedApp[]): RemoteRow[] {
    return connected.map((c) => {
      const hint = this.framePolicy(c.origin);
      return {
        id: c.appId ?? c.origin, name: c.name, path: c.origin, url: c.origin, remote: true, status: c.status,
        principalName: c.principalName, expiresAt: c.expiresAt, embeddable: hint === null, embedHint: hint,
        building: false, buildEnded: false,
      };
    });
  }

  /**
   * Start signing the agent in: a job the page polls. Where the page may embed
   * the app it shows the approval page itself, which hands the code back (the
   * CLI waits for it). Otherwise the approval opens in the browser; `here`
   * says that browser is on this machine, so it comes back to the CLI itself.
   * `embed: false` is a page that can embed nothing, whatever the policy.
   */
  connect(body: Record<string, unknown>): ApiReply {
    const origin = appOrigin(body.url);
    if (origin === null) return { status: 400, body: { ok: false, message: "Type the app's address, like https://crm.example.com." } };
    this.prune();
    const hint = this.framePolicy(origin);
    const embedded = hint === null && body.embed !== false;
    const job: ConnectJob = {
      id: randomBytes(8).toString("hex"), origin, approve: null, done: false, ok: false, pending: false,
      result: null, error: null, embedded, embedHint: hint, startedAt: new Date().toISOString(), endedAt: null,
    };
    this.jobs.set(job.id, job);
    let result: Record<string, unknown> | null = null;
    const argv = loginArgv(origin, !embedded && body.here === true, this.agentName);
    void runA2App(this.cliBin, argv, {
      onLine(line) {
        const event = parseLoginEvent(line);
        if (event === null) return;
        const { event: kind, ...rest } = event;
        if (kind === "approve") job.approve = rest;
        else result = rest;
      },
    }).then((r) => {
      const doc = result as Record<string, unknown> | null;
      job.result = doc;
      job.ok = r.ok && doc?.["ok"] === true;
      job.pending = job.ok && doc?.["pending"] === true;
      job.error = job.ok ? null : failureOf({ ...r, json: doc });
      job.endedAt = new Date().toISOString();
      job.done = true;
    });
    return { status: 200, body: { ok: true, job } };
  }

  job(id: unknown): ApiReply {
    const job = typeof id === "string" ? this.jobs.get(id) : undefined;
    if (job === undefined) return { status: 404, body: { ok: false, message: "no such sign-in — it may have ended over an hour ago" } };
    return { status: 200, body: { ok: true, job } };
  }

  /** Finish a sign-in with the confirmation code the approval page showed (or handed back). */
  async confirm(body: Record<string, unknown>): Promise<ApiReply> {
    const origin = appOrigin(body.url);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (origin === null || code === "") {
      return { status: 400, body: { ok: false, message: "Give the app's address and the confirmation code the approval page showed." } };
    }
    let doc: Record<string, unknown> | null = null;
    const r = await runA2App(this.cliBin, [origin, "login", "--confirm", code, "--events"], {
      onLine(line) {
        const event = parseLoginEvent(line);
        if (event !== null && event.event === "result") {
          const { event: _event, ...rest } = event;
          doc = rest;
        }
      },
    });
    const result = doc as Record<string, unknown> | null;
    if (r.ok && result?.["ok"] === true) return { status: 200, body: { ok: true, result } };
    return { status: r.code === 1 || r.code === 2 ? 400 : 500, body: { ok: false, message: failureOf({ ...r, json: result }) } };
  }

  /** Revoke the agent's credential for a connected app, and forget the app. */
  async disconnect(path: unknown): Promise<ApiReply> {
    const { connected } = await listApps(this.frameworkBin);
    if (typeof path !== "string" || !connected.some((c) => c.origin === path)) {
      return { status: 404, body: { ok: false, message: "not a connected app" } };
    }
    const r = await runA2App(this.cliBin, [path, "logout"]);
    return { status: r.ok ? 200 : 500, body: { ok: r.ok, message: r.ok ? "" : failureOf(r) } };
  }

  private prune(): void {
    const cutoff = Date.now() - this.keepMs;
    for (const [id, job] of this.jobs) {
      if (job.done && job.endedAt !== null && Date.parse(job.endedAt) < cutoff) this.jobs.delete(id);
    }
  }
}

/**
 * The first message of a connected app's session: another machine's app, which
 * the agent operates by its URL and never modifies.
 */
export function connectedSessionPreamble(name: string, origin: string): string {
  return (
    `You are working with the Agent App "${name}" at ${origin}, on another machine; this agent is signed in to it ` +
    "and acts for the person who approved that. Load the **connect** skill, then the **operator** skill: " +
    `address it as \`a2app ${origin}\`, never drive its UI. It cannot be modified from here.`
  );
}
