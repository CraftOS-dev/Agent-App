/**
 * The app registry as a manager reads it: `agent-app list --json`.
 */
import { runA2App, type CliResult } from "./cli.js";

/** One row of `agent-app list --json` — an app the user can evolve or operate. */
export interface KnownApp {
  id: string;
  name: string;
  path: string;
  port?: number;
  status?: string;
  url?: string | null;
}

/** Parse the `apps` array out of an `agent-app list --json` result. Tolerant: a
 *  non-JSON or error result yields an empty list rather than throwing, so the form
 *  still renders (just with no apps to evolve/operate). */
export function parseKnownApps(result: CliResult): KnownApp[] {
  const doc = result.json as { apps?: unknown } | null;
  const rows = doc && Array.isArray(doc.apps) ? doc.apps : [];
  return rows.flatMap((r) => {
    const a = r as Record<string, unknown>;
    if (typeof a.id !== "string" || typeof a.path !== "string") return [];
    const app: KnownApp = { id: a.id, name: typeof a.name === "string" ? a.name : a.id, path: a.path, url: typeof a.url === "string" ? a.url : null };
    if (typeof a.port === "number") app.port = a.port;
    if (typeof a.status === "string") app.status = a.status;
    return [app];
  });
}

/** Fetch the registry (for the Evolve/Operate dropdowns). Uses the build binary
 *  because `list` is a framework registry verb. */
export async function listKnownApps(frameworkBin = "agent-app"): Promise<KnownApp[]> {
  return parseKnownApps(await runA2App(frameworkBin, ["list", "--json"]));
}
