/**
 * agent-app <dir> credential list | mint | revoke — the app's delegated agent
 * credentials, managed with its admin credential (spec/v0_2/auth.md §2).
 *
 *   list                                         every live credential (never a token)
 *   mint [--for <login|account id>] [--scopes a,b] [--expires 30d] [--name <agent>]
 *                                                issue one; the token is printed once
 *   revoke <credentialId>                        it stops on the next request
 *
 * stdout carries the result as JSON: `{ ok, credentials }`, `{ ok, token,
 * credential }` (the token's only appearance) or `{ ok, revoked }`.
 *
 * For a harness with no browser (CI, a cloud agent): mint a credential for the
 * person the agent acts for and hand it over as A2APP_TOKEN. An agent that can
 * reach a browser uses `a2app <app> login` instead, approved by the person.
 */
import { flag, positionals } from "../lib/args.js";
import { parseDuration } from "../lib/duration.js";
import { log } from "../lib/log.js";
import { adminClient, loadProject, UsageError } from "../lib/project.js";
import type { A2AppClient, A2AppResponse } from "@a2app/sdk";

interface Credential {
  credentialId: string;
  principal: string;
  principalName: string | null;
  agentName: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  task: string | null;
}

function refused(what: string, res: A2AppResponse): number {
  const body = res.json as { code?: string; message?: string } | null;
  log.error(`The app refused to ${what} (${res.status}${body?.code ? ` ${body.code}` : ""}): ${body?.message ?? "no reason given"}`);
  return 1;
}

/** `--for` as a principal id: an account's login or id, or `owner`. */
async function principalFor(client: A2AppClient, who: string): Promise<string> {
  if (who === "owner") return who;
  const res = await client.request("GET", "/api/_a2app/users");
  if (res.status === 404) throw new UsageError(`This app has no accounts (authMode "none"): its only principal is "owner".`);
  const users = ((res.json as { users?: { id: string; login: string }[] } | null)?.users ?? []) as { id: string; login: string }[];
  const match = users.find((u) => u.id === who || u.login === who.trim().toLowerCase());
  if (!match) throw new UsageError(`No account "${who}" — use a login or account id from the app's People list.`);
  return match.id;
}

async function list(client: A2AppClient): Promise<number> {
  const res = await client.request("GET", "/api/_a2app/credentials");
  if (res.status !== 200) return refused("list credentials", res);
  const credentials = (res.json as { credentials: Credential[] }).credentials;
  if (credentials.length === 0) log.info("no credentials: no agent holds access to this app beyond its own .agent-token.");
  for (const c of credentials) {
    log.info(
      [
        c.credentialId,
        `for ${c.principalName ?? c.principal}`,
        c.agentName ? `agent "${c.agentName}"` : "unnamed agent",
        `scopes ${c.scopes.join(",")}`,
        `expires ${c.expiresAt ?? "never"}`,
        `last used ${c.lastUsedAt ?? "never"}`,
        ...(c.task ? [`task ${c.task}`] : []),
      ].join("  "),
    );
  }
  log.raw(JSON.stringify({ ok: true, credentials }, null, 2));
  return 0;
}

async function mint(client: A2AppClient, args: string[]): Promise<number> {
  const scopes = (flag(args, "scopes") ?? "*").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const expiresIn = parseDuration(flag(args, "expires") ?? "30d", "expires");
  const principal = await principalFor(client, flag(args, "for") ?? "owner");
  const agentName = flag(args, "name");
  const res = await client.request("POST", "/api/_a2app/credentials", {
    principal,
    scopes,
    expiresIn,
    ...(agentName !== undefined ? { agentName } : {}),
  });
  if (res.status !== 201) return refused("issue a credential", res);
  const issued = res.json as { token: string; credential: Credential };
  log.ok(
    `credential ${issued.credential.credentialId} for ${issued.credential.principalName ?? principal}, ` +
      `scopes ${issued.credential.scopes.join(",")}, expires ${issued.credential.expiresAt}`,
  );
  log.info("the token is shown once, in this result: hand it to the agent as A2APP_TOKEN, then let it go from this terminal.");
  log.raw(JSON.stringify({ ok: true, token: issued.token, credential: issued.credential }, null, 2));
  return 0;
}

async function revoke(client: A2AppClient, id: string | undefined): Promise<number> {
  if (!id) throw new UsageError("revoke needs a credential id: agent-app <dir> credential list shows them.");
  const res = await client.request("DELETE", `/api/_a2app/credentials/${encodeURIComponent(id)}`);
  if (res.status !== 200) return refused(`revoke ${id}`, res);
  log.ok(`revoked ${id}: it is refused from the next request on.`);
  log.raw(JSON.stringify({ ok: true, revoked: id }, null, 2));
  return 0;
}

export async function run(args: string[], app: string): Promise<number> {
  const [sub, id] = positionals(args);
  if (sub !== "list" && sub !== "mint" && sub !== "revoke") {
    throw new UsageError("credential takes list, mint or revoke <id>.");
  }
  const client = await adminClient(loadProject(app));
  if (sub === "list") return list(client);
  if (sub === "mint") return mint(client, args);
  return revoke(client, id);
}
