/**
 * agent-app blueprints
 *
 * The blueprints this CLI can scaffold an app from, each with what it is built
 * with. `scaffold` needs one by id, so the ids have to be findable from the CLI
 * itself, not from wherever its package happens to be installed.
 */
import { log } from "../lib/log.js";
import { availableToolkits } from "../lib/toolkit.js";

export async function run(_args: string[]): Promise<number> {
  const blueprints = availableToolkits().map((tk) => ({ id: tk.manifest.id, description: tk.manifest.description ?? null }));
  for (const b of blueprints) log.info(`${b.id.padEnd(28)} ${b.description ?? ""}`.trimEnd());
  log.raw(JSON.stringify({ ok: true, blueprints }, null, 2));
  return 0;
}
