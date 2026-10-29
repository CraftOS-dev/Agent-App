/**
 * agent-app <dir> import [--blueprint <id|path>] [--name <name>] [--port <n>]
 *                        [--set KEY=VALUE]… [--no-start] [--open] [--events]
 *
 * Install the folder `<dir>` in place: the install pipeline (framework
 * packaging §4) with `<dir>` as both the source and the destination, and
 * `untrusted` trust. A folder of unknown origin is made safe mechanically, not
 * trusted:
 *
 *   - it is staged and processed as a copy, so the folder is untouched until
 *     every check has passed — no partial re-vendor is ever left behind;
 *   - everything a package never carries is dropped: every credential file
 *     (a shipped `.agent-token` is an attacker's known key), the toolkit's data
 *     directory, runtime state, `.git/` and `node_modules/`;
 *   - the system files are replaced from a toolkit installed on THIS machine,
 *     chosen by the id the folder records (or `--blueprint`) — never by the
 *     path it records, and never from inside the folder itself;
 *   - it gets a fresh identity, port and credential.
 *
 * Only then is the folder's content swapped for the result, with its previous
 * content kept aside until the install is over, so a failure puts it back
 * exactly as it was. Afterwards a verifier agent runs the walk-verify skill:
 * an import is re-verified, never trusted on origin.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFlags } from "../lib/args.js";
import { INSTALL_FLAGS, install, portOf, setsOf } from "../lib/install.js";
import { readJsonFile } from "../lib/json.js";
import { identifyApp } from "../lib/net.js";
import { EnvError, UsageError } from "../lib/project.js";
import { find } from "../lib/registry.js";

/** The folder named: a directory, or a registered app's folder by id or name. */
function folderOf(app: string): string {
  const dir = resolve(app);
  if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  const registered = find(app);
  if (registered !== null && existsSync(registered.path)) return resolve(registered.path);
  throw new UsageError(`Not a folder: ${dir}`);
}

export async function run(args: string[], app: string): Promise<number> {
  const flags = parseFlags(args, INSTALL_FLAGS);
  if (flags.positionals.length > 0) throw new UsageError(`import takes no arguments after the folder (got ${flags.positionals.join(" ")})`);
  const dir = folderOf(app);

  // Its files are about to be swapped out; an app serving from them must stop first.
  const manifestPath = join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    let manifest: { id?: unknown; port?: unknown } = {};
    try {
      manifest = readJsonFile(manifestPath) as { id?: unknown; port?: unknown };
    } catch {
      /* not a readable manifest: nothing can be serving it */
    }
    if (typeof manifest.port === "number" && typeof manifest.id === "string" && (await identifyApp(manifest.port)) === manifest.id) {
      throw new EnvError(`${dir} is serving on port ${manifest.port} — stop it first (agent-app <dir> stop), then import`);
    }
  }

  const name = flags.values.get("name");
  const port = portOf(flags.values.get("port"));
  const blueprint = flags.values.get("blueprint");
  return install({
    request: { kind: "in-place", dir },
    ...(name !== undefined ? { name } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(blueprint !== undefined ? { blueprint } : {}),
    set: setsOf(flags.lists.get("set") ?? []),
    start: !flags.booleans.has("no-start"),
    open: flags.booleans.has("open"),
    events: flags.booleans.has("events"),
  });
}
