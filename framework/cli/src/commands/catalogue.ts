/**
 * agent-app catalogue [--search <words>] [--source <marketplace>]
 *
 * List the marketplace's apps (framework packaging §2, §8). The catalogue comes
 * from `--source`, else A2APP_MARKETPLACE, else `marketplace` in
 * `$A2APP_HOME/settings.json`, else the default marketplace — which alone falls
 * back to the legacy one when it is unavailable.
 *
 * Each app is marked `compatible` from what its entry lists, without
 * downloading it: true when every listed requirement is met here, false with
 * the `reason` when one is not, null when the entry lists none. `--search`
 * keeps the apps whose id, name, description or tags contain every word.
 */
import { parseFlags } from "../lib/args.js";
import { log } from "../lib/log.js";
import { compatibility, loadCatalogue, matchesSearch, previewOf } from "../lib/marketplace.js";
import { UsageError } from "../lib/project.js";

export async function run(args: string[]): Promise<number> {
  const flags = parseFlags(args, { values: ["search", "source"] });
  if (flags.positionals.length > 0) {
    throw new UsageError(`catalogue takes no arguments (got ${flags.positionals.join(" ")}) — to filter, use --search "<words>"`);
  }
  const loaded = await loadCatalogue(flags.values.get("source"));
  if (loaded.fallbackFrom !== null) {
    log.warn(`${loaded.fallbackFrom.location} is unavailable (${loaded.fallbackFrom.reason}) — using ${loaded.location}`);
  }
  for (const warning of loaded.warnings) log.warn(warning);

  const words = (flags.values.get("search") ?? "").split(/\s+/).filter((w) => w !== "");
  const apps = loaded.catalogue.apps
    .filter((entry) => matchesSearch(entry, words))
    .map((entry) => {
      const preview = previewOf(entry, loaded.marketplace);
      return { ...entry, ...(preview !== undefined ? { preview } : {}), ...compatibility(entry) };
    });

  const m = loaded.marketplace;
  const source = {
    kind: m.kind,
    location: loaded.location,
    ...(m.kind === "github" ? { repository: `${m.owner}/${m.repo}`, ref: m.ref } : {}),
    ...(loaded.fallbackFrom !== null ? { fallbackFrom: loaded.fallbackFrom } : {}),
  };
  log.ok(`${apps.length} app${apps.length === 1 ? "" : "s"}${words.length > 0 ? ` matching "${words.join(" ")}"` : ""} in ${loaded.location}`);
  log.raw(JSON.stringify({ ok: true, source, apps, ...(loaded.warnings.length > 0 ? { warnings: loaded.warnings } : {}) }, null, 2));
  return 0;
}
