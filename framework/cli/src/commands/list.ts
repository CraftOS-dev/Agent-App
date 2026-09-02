/**
 * agent-app list [--json] [--prune]
 *
 * Every known Agent App with its path, port, and DERIVED status (framework
 * section 5.6). Status is probed at read time, never read from a stored field:
 * `running` (something answers on its port), `stopped`, or `missing` (the
 * directory no longer holds an Agent App). `--prune` forgets missing entries;
 * it never deletes an app directory.
 */
import { hasFlag } from "../lib/args.js";
import { list, prune } from "../lib/registry.js";
import { registryPath } from "../lib/registry.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  if (hasFlag(args, "prune")) {
    const gone = await prune();
    for (const entry of gone) log.info(`forgot "${entry.name}" (${entry.path} no longer holds an Agent App)`);
    if (gone.length === 0) log.info("nothing to prune");
  }

  const apps = await list();

  if (hasFlag(args, "json")) {
    log.raw(JSON.stringify({ ok: true, registry: registryPath(), apps }, null, 2));
    return 0;
  }

  if (apps.length === 0) {
    log.info(`no Agent Apps registered yet (registry: ${registryPath()})`);
    log.raw(JSON.stringify({ ok: true, apps: [] }, null, 2));
    return 0;
  }

  const mark = { running: "●", stopped: "○", unreachable: "▲", missing: "✗" } as const;
  const width = Math.max(...apps.map((a) => a.name.length));
  for (const app of apps) {
    const port = app.port !== undefined ? String(app.port) : "—";
    const where = app.status === "running" && app.url !== null ? app.url : app.path;
    log.raw(`${mark[app.status]} ${app.name.padEnd(width)}  ${app.id}  :${port.padEnd(5)} ${app.status.padEnd(11)} ${where}`);
  }
  if (apps.some((a) => a.status === "unreachable")) {
    log.warn("▲ unreachable: another process holds that app's port — stop it, or give the app a different port.");
  }
  return 0;
}
