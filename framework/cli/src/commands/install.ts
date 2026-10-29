/**
 * agent-app install <catalogue id> [--source <marketplace>] | --from <source>
 *                   [--into <dir>] [--name <name>] [--port <n>] [--blueprint <id>]
 *                   [--set KEY=VALUE]… [--no-start] [--open] [--events]
 *
 * Install an app (framework packaging §4): from the marketplace by its
 * catalogue id, or `--from` a zip, a folder, a GitHub repository
 * (`github:<owner>/<repo>[@<ref>][/<path>]` or its https URL) or any git host
 * (`git+<url>[#<ref>]`). Every source runs the same pipeline — acquire,
 * inspect, sanitize, revendor, customize, place, register, dependencies, gate,
 * serve, open — and a step that fails leaves nothing registered or placed.
 *
 * `--no-start` installs the files only: dependencies, the build and the launch
 * are left to `agent-app <dir> serve --install`, and the gate runs without its
 * build step. `--events` writes one JSON line per step, then the result.
 *
 * A marketplace app is `catalogued` and owes nothing more; anything else is
 * `untrusted`, and the result names the walk-verify still owed.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags } from "../lib/args.js";
import { INSTALL_FLAGS, install, portOf, requestOf, setsOf } from "../lib/install.js";
import { UsageError } from "../lib/project.js";

export async function run(args: string[]): Promise<number> {
  const flags = parseFlags(args, {
    values: [...INSTALL_FLAGS.values, "from", "into", "source"],
    lists: INSTALL_FLAGS.lists,
    booleans: INSTALL_FLAGS.booleans,
  });
  const request = requestOf(flags.positionals, flags.values.get("from"), flags.values.get("source"));
  const into = flags.values.get("into");
  // Checked before anything is downloaded; place checks again, since a folder can fill up meanwhile.
  if (into !== undefined && existsSync(resolve(into)) && readdirSync(resolve(into)).length > 0) {
    throw new UsageError(`--into ${resolve(into)} is not empty: install into a new or empty folder`);
  }
  const name = flags.values.get("name");
  const port = portOf(flags.values.get("port"));
  const blueprint = flags.values.get("blueprint");
  return install({
    request,
    ...(into !== undefined ? { into } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(blueprint !== undefined ? { blueprint } : {}),
    set: setsOf(flags.lists.get("set") ?? []),
    start: !flags.booleans.has("no-start"),
    open: flags.booleans.has("open"),
    events: flags.booleans.has("events"),
  });
}
