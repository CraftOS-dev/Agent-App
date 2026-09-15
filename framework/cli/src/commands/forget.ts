/**
 * agent-app <app> forget — drop an app's registry entry, releasing the port it
 * reserved. The app's FILES ARE NEVER TOUCHED; this only edits the index. It is
 * the missing exit for the write-only registry: `stop` frees the live port but
 * deliberately keeps the row (so the app stays listed), and nothing else removes
 * one — dead entries therefore accumulate, each holding a port `reserveApp`
 * treats as claimed. `forget` is that removal.
 *
 * Idempotent: forgetting an app that is not registered succeeds (the desired
 * post-condition already holds), mirroring `stop` on an app that is not serving.
 *
 * A RUNNING app is refused unless --force: its port is genuinely in use and
 * dropping the row would orphan the process from `list`. To delete an app's
 * files as well, use `remove`.
 */
import { AmbiguousAppError, find, unregister, view } from "../lib/registry.js";
import { UsageError } from "../lib/project.js";
import { hasFlag } from "../lib/args.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  let entry;
  try {
    // Resolve by id, then exact name, then path (an ambiguous name is surfaced,
    // never guessed). Works on a dead entry too: this reads the registry only and
    // never requires the directory to still exist.
    entry = find(app);
  } catch (err) {
    if (err instanceof AmbiguousAppError) throw new UsageError(err.message);
    throw err;
  }

  if (entry === null) {
    log.info(`"${app}" is not registered — nothing to forget.`);
    log.raw(JSON.stringify({ ok: true, forgot: null }, null, 2));
    return 0;
  }

  if (!hasFlag(args, "force")) {
    const v = await view(entry);
    if (v.status === "running") {
      log.error(
        `"${entry.name}" is running on port ${entry.port ?? "?"} — stop it first (\`agent-app stop\`), ` +
          `or pass --force to forget it anyway (the process keeps running, untracked).`,
      );
      log.raw(JSON.stringify({ ok: false, forgot: null, reason: "running" }, null, 2));
      return 1;
    }
  }

  const removed = await unregister(entry.path);
  log.ok(`forgot "${entry.name}"${entry.port !== undefined ? ` (port ${entry.port} released)` : ""}`);
  log.raw(
    JSON.stringify(
      {
        ok: true,
        forgot: removed
          ? { id: entry.id, name: entry.name, path: entry.path, port: entry.port ?? null }
          : null,
      },
      null,
      2,
    ),
  );
  return 0;
}
