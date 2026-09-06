/**
 * The describe budget walk (A2APP-SPEC 1, framework spec 5.3 step 7).
 *
 * Every describe response fits 2,000 characters at any level, for an app of any
 * size. This walks a RUNNING app's own describe — root, then every module, then
 * every entity — and reports each level that does not fit.
 *
 * Why it walks the live surface rather than computing a size from the
 * declarations: the budget is a property of what the app actually serves, and
 * the app is the only thing that knows. A predicted size would drift from the
 * served one the moment an adapter added a field to a level, and the drift would
 * favour a false pass.
 *
 * This is the first budget enforcement in the framework. The budget has been
 * contractual since the first version and was never measured, which is why the
 * reference adapter came to exceed it unnoticed.
 */
import { DESCRIBE_BUDGET_CHARS } from "@a2app/rules";
import type { A2AppClient, DescribeLevel } from "@a2app/sdk";

/**
 * Serialized size of a level, in the units the budget is stated in.
 *
 * Deliberately NOT imported from `@a2app/adapter-core`, which exports the same
 * one-liner. The CLI is a protocol *client*; the adapter is the *server*. Taking
 * a dependency on the served surface to save one line would invert the layering
 * and make the operate client unusable against an app it does not host. The
 * budget constant itself IS shared, from the pure-rules package both sides
 * already depend on — that is the value that must never drift.
 */
function levelSize(level: DescribeLevel): number {
  return JSON.stringify(level).length;
}

export interface BudgetOverrun {
  path: string;
  level: string;
  chars: number;
}

export interface BudgetReport {
  checked: number;
  overruns: BudgetOverrun[];
  /** null when the app served no root level at all (not running, or no adapter) */
  reachable: boolean;
}

/**
 * Walk every level the app can serve and measure each one.
 *
 * Modules are enumerated with `?all=true` so that a module which truncated its
 * own listing is still measured against its full entity set — otherwise an app
 * could pass by hiding the very entities that would overflow, and truncation
 * would become a way to launder an over-budget model.
 */
export async function walkDescribeBudget(
  client: A2AppClient,
  budget = DESCRIBE_BUDGET_CHARS,
): Promise<BudgetReport> {
  const overruns: BudgetOverrun[] = [];
  let checked = 0;

  const record = (path: string, level: DescribeLevel): void => {
    checked++;
    const chars = levelSize(level);
    if (chars > budget) overruns.push({ path: path === "" ? "(root)" : path, level: level.level, chars });
  };

  const root = await client.describeRoot();
  if (root === null) return { checked: 0, overruns: [], reachable: false };
  record("", root);

  for (const module of root.modules) {
    // A module the credential cannot reach cannot be measured through it. Skip
    // rather than report a false pass on an empty response.
    if (module.access === "none") continue;

    const listing = await client.describe(module.name, { all: true });
    if (listing === null || listing.level !== "module") continue;
    record(module.name, listing);

    for (const entity of listing.entities) {
      const level = await client.describe(`${module.name}/${entity.name}`);
      if (level === null) continue;
      record(`${module.name}/${entity.name}`, level);
    }
  }

  return { checked, overruns, reachable: true };
}

/** One actionable line per overrun, naming what to split. */
export function describeOverruns(report: BudgetReport, budget = DESCRIBE_BUDGET_CHARS): string {
  return report.overruns
    .map((o) => {
      const advice =
        o.level === "module"
          ? "split this module"
          : o.level === "entity"
            ? "split this entity, or move fields into a related one"
            : "the app has too many modules to list; consolidate them";
      return `  ${o.path} (${o.level}): ${o.chars} chars, budget ${budget} — ${advice}`;
    })
    .join("\n");
}
