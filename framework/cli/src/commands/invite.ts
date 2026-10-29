/**
 * agent-app <dir> invite [--role member|owner] — a one-time setup link for a
 * new account on a multi-user app (spec/v0_2/auth.md §4).
 *
 * Uses the app's admin credential, so it works before anyone has an account:
 * `agent-app <dir> owner` is this command with `--role owner`, and is how the
 * first owner is created. The link is printed once and is good for 7 days; the
 * person opens it and chooses their own login and password — no password ever
 * passes through here. stdout carries `{ ok, role, url, expiresAt }`.
 */
import { flag } from "../lib/args.js";
import { log } from "../lib/log.js";
import { adminClient, loadProject, UsageError } from "../lib/project.js";

export async function invite(args: string[], app: string, role: string): Promise<number> {
  if (role !== "member" && role !== "owner") throw new UsageError('--role is "member" or "owner".');
  const project = loadProject(app);
  const client = await adminClient(project);
  const res = await client.request("POST", "/api/_a2app/invites", { role });
  const body = res.json as { code?: string; message?: string; url?: string; expiresAt?: string } | null;
  if (res.status === 404 && body?.code === "not_multi_user") {
    log.error(
      `${project.manifest.name ?? app} has no accounts: its authMode is "none", so its one principal is the owner. ` +
        `Scaffold with --auth-mode multi-user for an app with accounts.`,
    );
    return 1;
  }
  if (res.status !== 201 || !body?.url) {
    log.error(`The app refused the invite (${res.status}${body?.code ? ` ${body.code}` : ""}): ${body?.message ?? "no reason given"}`);
    return 1;
  }
  log.ok(`one-time setup link for a new ${role} (valid until ${body.expiresAt}): ${body.url}`);
  log.info("send it to the person; they choose their own login and password there.");
  log.raw(JSON.stringify({ ok: true, role, url: body.url, expiresAt: body.expiresAt ?? null }, null, 2));
  return 0;
}

export async function run(args: string[], app: string): Promise<number> {
  return invite(args, app, flag(args, "role") ?? "member");
}
