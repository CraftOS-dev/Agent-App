/**
 * a2app <app> login [--scopes a,b] [--expires 30d] [--name <agent>]
 *
 * How an agent gets access to an app (spec/v0_2/auth.md §7): it asks, the
 * person approves on the app's own account page — signed in as themselves —
 * and the app issues the agent a credential that acts for them. The agent never
 * sees their password or session, and the token never appears in this
 * process's output: it goes straight into credentials.json (0600), where every
 * later `a2app` command against this app finds it.
 *
 * The browser is opened for the person when the app is on this machine; for a
 * remote app the link and the code are printed, for them to open wherever they
 * are signed in.
 */
import { hostname } from "node:os";
import { A2AppClient } from "@a2app/sdk";
import { flag } from "../lib/args.js";
import { parseDuration } from "../lib/duration.js";
import { log } from "../lib/log.js";
import { identifyApp, appPort } from "../lib/net.js";
import { UsageError } from "../lib/project.js";
import { credentialsPath, originOf, saveCredential } from "../lib/remote.js";
import { resolveTarget, verifyRemote, type Target } from "../lib/target.js";
import { openUrl } from "./open.js";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(args: string[], app: string): Promise<number> {
  const scopes = (flag(args, "scopes") ?? "*").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const expiresIn = parseDuration(flag(args, "expires") ?? "30d", "expires");
  const agentName = flag(args, "name") ?? process.env["A2APP_AGENT"] ?? `agent on ${hostname()}`;
  const { client, origin, appId, name, local } = await loginTarget(app);

  const started = await client.request("POST", "/api/_a2app/auth/device", { agentName, scopes, expiresIn });
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

  log.info(`To let this agent use ${name}, the person it will act for opens:`);
  log.raw(ask.verificationUriComplete);
  log.info(`and approves code ${ask.userCode} (it expires in ${Math.round(ask.expiresIn / 60)} minutes).`);
  if (local) {
    const opened = await openUrl(ask.verificationUriComplete, false);
    if (opened.opened) log.info("opened it in the browser.");
  }

  const deadline = Date.now() + ask.expiresIn * 1000;
  let interval = ask.interval;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const polled = await client.request("POST", "/api/_a2app/auth/token", { deviceCode: ask.deviceCode });
    const body = polled.json as {
      code?: string;
      message?: string;
      interval?: number;
      token?: string;
      credential?: { credentialId: string; principal: string; principalName: string | null; scopes: string[]; expiresAt: string | null };
    } | null;
    if (polled.status === 200 && body?.token && body.credential) {
      await saveCredential({
        origin,
        appId,
        token: body.token,
        credentialId: body.credential.credentialId,
        principal: body.credential.principal,
        expiresAt: body.credential.expiresAt,
      });
      log.ok(
        `approved: this agent now acts as ${body.credential.principalName ?? body.credential.principal} in ${name} ` +
          `(${body.credential.scopes.includes("*") ? "everything they can do" : body.credential.scopes.join(", ")}), ` +
          `until ${body.credential.expiresAt}.`,
      );
      log.info(`the credential is stored in ${credentialsPath()}; every a2app command against this app uses it.`);
      return 0;
    }
    if (body?.code === "authorization_pending") continue;
    if (body?.code === "slow_down") {
      interval = body.interval ?? interval + 5;
      continue;
    }
    if (body?.code === "access_denied") {
      log.error("the person declined: this agent has no access.");
      return 1;
    }
    if (body?.code === "expired_token") break;
    log.error(`the app answered the poll with ${polled.status}${body?.code ? ` ${body.code}` : ""}: ${body?.message ?? "no reason given"}`);
    return 1;
  }
  log.error("nobody approved the request in time: run `a2app <app> login` again for a new code.");
  return 1;
}
