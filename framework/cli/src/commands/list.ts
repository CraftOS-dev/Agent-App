/**
 * agent-app list [--json] [--prune]
 *
 * Every known Agent App with its path, port, and DERIVED status (framework
 * section 5.6). Status is probed at read time, never read from a stored field:
 * `running` (something answers on its port), `stopped`, or `missing` (the
 * directory no longer holds an Agent App). `--prune` forgets missing entries;
 * it never deletes an app directory.
 *
 * A running app's agent work is shown too: whether a bridge is starting agent
 * runs for its queued tasks, and how many wait. Only running apps are asked —
 * a stopped app has no queue to read, and a bridge cannot start for it.
 *
 * Apps on other machines that this machine holds a credential for (`a2app
 * <url> login`) are listed as `connected`, with who the credential acts for and
 * a status probed the same way: `online` (it answers as itself), `offline`,
 * `unreachable` (it answers as another app), or `expired` (the credential).
 */
import { A2AppClient } from "@a2app/sdk";
import { hasFlag } from "../lib/args.js";
import { readCredentials, type StoredCredential } from "../lib/remote.js";
import { list, prune, type AppView } from "../lib/registry.js";
import { registryPath } from "../lib/registry.js";
import { log } from "../lib/log.js";
import { appCommand, inspectAgentWork, tasksPhrase, type AgentWork } from "../lib/delivery.js";

/**
 * How to name an app in a command for someone to paste: its registered name
 * when that resolves to it alone, else its id, else its directory. The name is
 * what the person sees in this table; the path is the last resort.
 */
function refFor(app: AppView, apps: AppView[]): string {
  const unique = (ref: string): boolean =>
    !apps.some((a) => a !== app && (a.id === ref || a.name === ref));
  if (unique(app.name) && !/["%!$`]/.test(app.name)) return app.name;
  if (unique(app.id)) return app.id;
  return app.path;
}

/**
 * The row's agent-work markers, or "" when the app shows no sign of any: no
 * bridge record and nothing waiting. `list` reads only the waiting tasks (a
 * dashboard may run it every few seconds), so an app whose queue holds only
 * finished work is not marked here; `serve` and `bridge` read the whole queue.
 */
function markers(app: AppView, work: AgentWork | undefined): string {
  if (work === undefined) return app.bridge !== null ? "  bridge:running" : "";
  if (work.bridge === "none" && !((work.tasksWaiting ?? 0) > 0)) return "";
  const bridge =
    work.bridge !== "running" ? work.bridge
      : work.bridgeTarget === "other" ? "wrong-target"
        : work.notPickedUp ? "not-picking-up"
          : "running";
  return `  bridge:${bridge}  waiting:${work.tasksWaiting ?? "?"}`;
}

/** A per-app warning, only when tasks are waiting and no bridge here is taking them. */
function stuck(app: AppView, work: AgentWork | undefined, ref: string): string | null {
  const n = work?.tasksWaiting ?? null;
  if (work === undefined || n === null || n === 0) return null;
  const start = appCommand(ref, "bridge start");
  const restart = `${appCommand(ref, "bridge stop")}, then ${start}`;
  const who = `"${app.name}": ${tasksPhrase(n)} waiting`;
  if (work.bridge === "running") {
    if (work.bridgeTarget === "other") {
      const fix = work.devUrl !== null
        ? `Promote or abandon the dev change (${appCommand(ref, "promote")} or ${appCommand(ref, "stop --dev")}), then restart it: ${restart}`
        : `Restart it: ${restart}`;
      return `${who}; its bridge takes work from ${work.running?.baseUrl}. ${fix}`;
    }
    if (work.notPickedUp) {
      return `${who}; its bridge (pid ${work.running?.pid}) has not picked ${n === 1 ? "it" : "them"} up in ${Math.round((work.oldestWaitingMs ?? 0) / 1000)}s. Restart it: ${restart}`;
    }
    if (work.tasksNotTaken > 0) {
      return `${who}; ${work.tasksNotTaken} ${work.tasksNotTaken === 1 ? "needs" : "need"} a capability its bridge does not take. Restart it for all of them: ${restart}`;
    }
    return null;
  }
  if (work.bridge === "stale") return `${who}; its bridge is no longer running. Restart it: ${start}`;
  return `${who} and no bridge is running. Start one: ${start}`;
}

/** An app on another machine this one holds a credential for. */
interface Connected {
  origin: string;
  appId: string | null;
  name: string;
  principal: string | null;
  principalName: string | null;
  credentialId: string | null;
  expiresAt: string | null;
  status: "online" | "offline" | "unreachable" | "expired";
}

/** How long `list` waits for a connected app to answer: a dashboard runs it
 *  every few seconds, and an app that slow is as good as offline. */
const PROBE_TIMEOUT_MS = 3_000;

async function probe(cred: StoredCredential): Promise<Connected["status"]> {
  if (cred.expiresAt && Date.parse(cred.expiresAt) <= Date.now()) return "expired";
  const client = new A2AppClient({ baseUrl: cred.origin, token: null, agentName: "agent-app-list", timeoutMs: PROBE_TIMEOUT_MS });
  try {
    const identity = await client.identity();
    if (identity === null) return "offline";
    return cred.appId === undefined || identity.app?.id === cred.appId ? "online" : "unreachable";
  } catch {
    return "offline";
  }
}

/** Every stored credential for an app that is not one of this machine's own. */
async function connectedApps(apps: AppView[]): Promise<Connected[]> {
  const local = new Set(apps.map((a) => a.id));
  const creds = readCredentials().filter((c) => !(c.appId !== undefined && local.has(c.appId)));
  return Promise.all(
    creds.map(async (c) => ({
      origin: c.origin,
      appId: c.appId ?? null,
      name: c.name ?? new URL(c.origin).host,
      principal: c.principal ?? null,
      principalName: c.principalName ?? null,
      credentialId: c.credentialId ?? null,
      expiresAt: c.expiresAt ?? null,
      status: await probe(c),
    })),
  );
}

function printConnected(connected: Connected[]): void {
  if (connected.length === 0) return;
  const mark = { online: "◆", offline: "◇", unreachable: "▲", expired: "✗" } as const;
  const width = Math.max(...connected.map((c) => c.name.length));
  log.raw("");
  log.raw("Connected (apps on other machines):");
  for (const c of connected) {
    const who = c.principalName ?? c.principal;
    log.raw(
      `${mark[c.status]} ${c.name.padEnd(width)}  ${c.origin}  ${c.status.padEnd(11)}` +
        `${who ? `  acts as ${who}` : ""}${c.expiresAt ? `  until ${c.expiresAt}` : ""}`,
    );
  }
  if (connected.some((c) => c.status === "expired")) {
    log.info("✗ expired: sign in again with `a2app <url> login`.");
  }
  if (connected.some((c) => c.status === "unreachable")) {
    log.warn("▲ unreachable: that address now answers as a different app; the CLI will refuse to operate it.");
  }
}

export async function run(args: string[]): Promise<number> {
  if (hasFlag(args, "prune")) {
    const gone = await prune();
    for (const entry of gone) log.info(`forgot "${entry.name}" (${entry.path} no longer holds an Agent App)`);
    if (gone.length === 0) log.info("nothing to prune");
  }

  const apps = await list();
  const connected = await connectedApps(apps);
  // Status is settled first; only an app answering as itself is asked about its
  // queue, and that answer stands in for the identity check the read needs.
  // Only the waiting tasks are read: an app's whole history is never pruned,
  // and a dashboard may run `list --json` every few seconds.
  const work = new Map<AppView, AgentWork>();
  await Promise.all(
    apps
      .filter((a) => a.status === "running" && a.url !== null)
      .map(async (a) =>
        work.set(a, await inspectAgentWork(a.path, a.id, a.url!, { identityVerified: true, history: false })),
      ),
  );

  if (hasFlag(args, "json")) {
    const rows = apps.map((a) => ({ ...a, agentWork: work.get(a) ?? null }));
    log.raw(JSON.stringify({ ok: true, registry: registryPath(), apps: rows, connected }, null, 2));
    return 0;
  }

  if (apps.length === 0) {
    log.info(`no Agent Apps registered yet (registry: ${registryPath()})`);
    printConnected(connected);
    log.raw(JSON.stringify({ ok: true, apps: [], connected }, null, 2));
    return 0;
  }

  const mark = { running: "●", stopped: "○", unreachable: "▲", missing: "✗" } as const;
  const width = Math.max(...apps.map((a) => a.name.length));
  const warnings: string[] = [];
  let anyMarkers = false;
  for (const app of apps) {
    const port = app.port !== undefined ? String(app.port) : "—";
    const where = app.status === "running" && app.url !== null ? app.url : app.path;
    // A dev instance is part of the app's state, so it shows on the app's own
    // row — an abandoned candidate that only lived in `.a2app/dev.json` was
    // invisible here, which is exactly how it stayed abandoned.
    const dev = app.dev === null ? "" : app.dev.answering ? `  dev:${app.dev.port}` : "  dev:stale";
    // A bridge is a standing capability — while it runs, the app can start
    // agent runs on this machine — so it belongs where someone looks to see
    // what their apps are doing, as does work that nothing is picking up.
    const agent = markers(app, work.get(app));
    if (agent !== "") anyMarkers = true;
    log.raw(
      `${mark[app.status]} ${app.name.padEnd(width)}  ${app.id}  :${port.padEnd(5)} ${app.status.padEnd(11)} ${where}${dev}${agent}`,
    );
    const warning = stuck(app, work.get(app), refFor(app, apps));
    if (warning !== null) warnings.push(warning);
  }
  printConnected(connected);
  for (const warning of warnings) log.warn(warning);
  if (apps.some((a) => a.status === "unreachable")) {
    log.warn("▲ unreachable: another process holds that app's port — stop it, or give the app a different port.");
  }
  if (apps.some((a) => a.dev !== null && a.dev.answering)) {
    log.info(
      "dev:<port> — a candidate is up and operate commands target IT, not live. " +
        "Finish it: `agent-app <app> promote` · abandon it: `agent-app <app> stop --dev`.",
    );
  }
  if (apps.some((a) => a.dev !== null && !a.dev.answering)) {
    log.info("dev:stale — a recorded dev instance is no longer answering; `agent-app <app> stop --dev` clears it.");
  }
  if (anyMarkers) {
    log.info(
      "bridge:running|not-picking-up|stale|none|wrong-target waiting:<n>|? — the local bridge that starts agent runs for that app's " +
        "queued tasks, and how many wait. `agent-app <app> bridge` for detail · `agent-app <app> bridge stop` ends or clears one.",
    );
  }
  return 0;
}
