/**
 * a2app <app> login [--scopes data:<entity>:read,data:<entity>:write,op:<name>]
 *                   [--expires 30d] [--name <agent>] [--no-browser]
 * a2app <app> login --confirm <code>
 *
 * How an agent gets access to an app (spec/v0_2/auth.md §7): it asks, the
 * person approves on the app's own account page — signed in as themselves —
 * and the app issues the agent a credential that acts for them. The agent never
 * sees their password or session, and the token never appears in this
 * process's output: it goes straight into credentials.json (0600), where every
 * later `a2app` command against this app finds it.
 *
 * Approving hands over nothing by itself: it yields a confirmation code, and
 * the credential goes only to whoever presents it. So a person who approves a
 * link someone else sent them gives that someone nothing.
 *
 * - On the person's computer (this process opens their browser), the code
 *   comes back to a loopback port (RFC 8252) and the sign-in finishes by itself.
 * - Anywhere else (`--no-browser`, a headless machine, or an empty
 *   AGENT_APP_OPEN_CMD), the link and code are printed and this process stops; the
 *   person approves and gives the agent the confirmation code, and
 *   `login --confirm <code>` finishes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { A2AppClient } from "@a2app/sdk";
import { flag, hasFlag, scopesFlag } from "../lib/args.js";
import { parseDuration } from "../lib/duration.js";
import { log } from "../lib/log.js";
import { identifyApp, appPort } from "../lib/net.js";
import { UsageError } from "../lib/project.js";
import { credentialsPath, forgetPendingLogin, originOf, pendingLoginFor, saveCredential, savePendingLogin } from "../lib/remote.js";
import { resolveTarget, verifyRemote, type Target } from "../lib/target.js";
import { headlessReason, openUrl } from "./open.js";

/** The app to sign in to, verified, with nothing presented: login is how a
 *  credential is obtained, so none is sent. */
export async function loginTarget(app: string): Promise<{ client: A2AppClient; origin: string; appId: string; name: string; local: boolean }> {
  const target: Target = resolveTarget(app);
  if (target.kind === "local") {
    const { manifest } = target.project;
    const answering = await identifyApp(appPort(manifest));
    if (answering === null) throw new UsageError(`${manifest.name} is not running. Start it: agent-app <dir> serve`);
    if (answering !== manifest.id) {
      throw new UsageError(`${target.project.baseUrl} answers as app "${answering}", not ${manifest.id}: another app holds this port.`);
    }
    const client = new A2AppClient({ baseUrl: target.project.baseUrl, token: null, agentName: "a2app-login" });
    return { client, origin: originOf(target.project.baseUrl), appId: manifest.id, name: manifest.name, local: true };
  }
  const client = new A2AppClient({ baseUrl: target.baseUrl, token: null, agentName: "a2app-login" });
  await verifyRemote(client, target);
  return { client, origin: target.origin, appId: target.appId!, name: target.appName ?? target.origin, local: false };
}

/** Where the account page sends the browser back with the confirmation code. */
const CALLBACK_PATH = "/a2app/callback";

const RETURNED_PAGE =
  "<!doctype html><meta charset=utf-8><title>Approved</title>" +
  "<p style=\"font:16px system-ui;margin:3rem auto;max-width:32rem\">Approved. You can close this tab and return to your agent.</p>";

/**
 * The loopback half of RFC 8252: a listener on 127.0.0.1 that the account page
 * returns the person's browser to, carrying the confirmation code. Only this
 * computer can reach it, which is the point.
 */
class Loopback {
  private readonly server = createServer((req, res) => this.receive(req, res));
  private readonly codes: string[] = [];
  private wake: (() => void) | null = null;

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    return (this.server.address() as { port: number }).port;
  }

  private receive(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.pathname === CALLBACK_PATH ? url.searchParams.get("confirmation") : null;
    if (!code) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(RETURNED_PAGE);
    this.codes.push(code);
    this.wake?.();
  }

  /** The next code the browser brought back, if any. */
  take(): string | null {
    return this.codes.shift() ?? null;
  }

  /** Wait up to `ms`, or until a code arrives. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  close(): void {
    this.server.close();
  }
}

/** Whether this process opens the person's browser, on this computer — itself,
 *  or through the harness that spawned it (AGENT_APP_OPEN_CMD; empty means
 *  never). Only then can the confirmation come back to a loopback port. */
function opensBrowserHere(args: string[]): boolean {
  if (hasFlag(args, "no-browser")) return false;
  const opener = process.env["AGENT_APP_OPEN_CMD"];
  return opener !== undefined ? opener.trim() !== "" : headlessReason() === null;
}

type IssuedBody = {
  code?: string;
  message?: string;
  interval?: number;
  token?: string;
  credential?: { credentialId: string; principal: string; principalName: string | null; scopes: string[]; expiresAt: string | null };
};

/** One poll's outcome, as far as this command cares. */
type Polled =
  | { kind: "issued"; body: Required<Pick<IssuedBody, "token" | "credential">> }
  | { kind: "wait"; interval?: number }
  | { kind: "confirm" }
  | { kind: "wrong" }
  | { kind: "end"; message: string };

async function poll(client: A2AppClient, deviceCode: string, confirmation: string | null): Promise<Polled> {
  const res = await client.request("POST", "/api/_a2app/auth/token", confirmation === null ? { deviceCode } : { deviceCode, confirmation });
  const body = res.json as IssuedBody | null;
  if (res.status === 200 && body?.token && body.credential) return { kind: "issued", body: { token: body.token, credential: body.credential } };
  switch (body?.code) {
    case "authorization_pending":
      return { kind: "wait" };
    case "slow_down":
      return { kind: "wait", ...(body.interval !== undefined ? { interval: body.interval } : {}) };
    case "confirmation_required":
      return { kind: "confirm" };
    case "confirmation_invalid":
      return { kind: "wrong" };
    case "access_denied":
      return { kind: "end", message: `no access: ${body.message ?? "the person declined"}` };
    case "expired_token":
      return { kind: "end", message: "the sign-in request expired: run `a2app <app> login` again for a new code." };
    default:
      return { kind: "end", message: `the app answered with ${res.status}${body?.code ? ` ${body.code}` : ""}: ${body?.message ?? "no reason given"}` };
  }
}

async function store(issued: Extract<Polled, { kind: "issued" }>["body"], origin: string, appId: string, name: string): Promise<number> {
  const { token, credential } = issued;
  await saveCredential({ origin, appId, token, credentialId: credential.credentialId, principal: credential.principal, expiresAt: credential.expiresAt });
  log.ok(
    `approved: this agent now acts as ${credential.principalName ?? credential.principal} in ${name} ` +
      `(${credential.scopes.includes("*") ? "everything they can do" : credential.scopes.join(", ")}), until ${credential.expiresAt}.`,
  );
  log.info(`the credential is stored in ${credentialsPath()}; every a2app command against this app uses it.`);
  return 0;
}

/** `login --confirm <code>`: finish a sign-in with the code the person was given. */
async function confirm(app: string, code: string): Promise<number> {
  const { client, origin, appId, name } = await loginTarget(app);
  const pending = pendingLoginFor(origin, appId);
  if (pending === null) {
    throw new UsageError(`no sign-in to ${name} is waiting for a confirmation code: start one with \`a2app <app> login\`.`);
  }
  const outcome = await poll(client, pending.deviceCode, code);
  switch (outcome.kind) {
    case "issued":
      await forgetPendingLogin(origin, appId);
      return store(outcome.body, origin, appId, name);
    case "wrong":
      log.error("that is not the confirmation code for this sign-in: check it with the person and try again.");
      return 1;
    case "wait":
    case "confirm":
      log.error("the person has not approved this sign-in yet: the confirmation code appears once they do.");
      return 1;
    case "end":
      await forgetPendingLogin(origin, appId);
      log.error(outcome.message);
      return 1;
  }
}

export async function run(args: string[], app: string): Promise<number> {
  const confirmation = flag(args, "confirm");
  if (confirmation !== undefined) return confirm(app, confirmation);

  const scopes = scopesFlag(args);
  const expiresIn = parseDuration(flag(args, "expires") ?? "30d", "expires");
  const agentName = flag(args, "name") ?? process.env["A2APP_AGENT"] ?? `agent on ${hostname()}`;
  const { client, origin, appId, name } = await loginTarget(app);

  const loopback = opensBrowserHere(args) ? new Loopback() : null;
  try {
    const loopbackPort = loopback === null ? null : await loopback.listen();
    const started = await client.request("POST", "/api/_a2app/auth/device", {
      agentName,
      scopes,
      expiresIn,
      ...(loopbackPort !== null ? { loopbackPort } : {}),
    });
    const ask = started.json as {
      code?: string;
      message?: string;
      deviceCode: string;
      userCode: string;
      verificationUriComplete: string;
      expiresIn: number;
      interval: number;
    } | null;
    if (started.status === 404) {
      log.error(`${name} predates agent sign-in (protocol 0.1): ask its owner for a credential instead.`);
      return 1;
    }
    if (started.status !== 200 || !ask?.deviceCode) {
      log.error(`${name} refused the sign-in request (${started.status}${ask?.code ? ` ${ask.code}` : ""}): ${ask?.message ?? "no reason given"}`);
      return 1;
    }
    const expiresAt = new Date(Date.now() + ask.expiresIn * 1000).toISOString();

    log.info(`To let this agent use ${name}, the person it will act for opens:`);
    log.raw(ask.verificationUriComplete);
    log.info(`and approves code ${ask.userCode} (it expires in ${Math.round(ask.expiresIn / 60)} minutes).`);

    if (loopback === null) {
      await savePendingLogin({ origin, appId, deviceCode: ask.deviceCode, expiresAt });
      log.info(
        "Not signed in yet. Once they approve, the page shows a confirmation code: they give it to this agent, " +
          "which finishes with `a2app <app> login --confirm <code>`.",
      );
      return 0;
    }

    const opened = await openUrl(ask.verificationUriComplete, false);
    log.info(opened.opened ? "opened it in the browser; this finishes when they approve." : "open it in the browser on this computer; this finishes when they approve.");
    let interval = ask.interval;
    while (Date.now() < Date.parse(expiresAt)) {
      await loopback.wait(interval * 1000);
      const outcome = await poll(client, ask.deviceCode, loopback.take());
      if (outcome.kind === "issued") return store(outcome.body, origin, appId, name);
      if (outcome.kind === "end") {
        log.error(outcome.message);
        return 1;
      }
      if (outcome.kind === "wait" && outcome.interval !== undefined) interval = outcome.interval;
      // "confirm": approved, and the browser is on its way back; "wrong": something
      // other than that browser reached the port. Either way, keep waiting for it.
    }
    log.error("nobody approved the request in time: run `a2app <app> login` again for a new code.");
    return 1;
  } finally {
    loopback?.close();
  }
}
