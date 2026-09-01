/**
 * a2app run <dir> <operation> [--field value ...] [--approve <key>]
 *
 * Invoke a declared operation. A destructive operation returns
 * `approval_required` with a content-addressed key; re-run with `--approve <key>`
 * to execute. The CLI never self-approves.
 */
import { collectFields, flag, positionals } from "../lib/args.js";
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const [dir, opName] = positionals(args);
  if (dir === undefined || opName === undefined) {
    throw new UsageError("Usage: a2app run <dir> <operation> [--field value ...] [--approve <key>]");
  }
  const client = await clientFor(loadProject(dir));
  const fields = collectFields(args);
  const approvalKey = flag(args, "approve");
  const res = await client.callOperation(opName, fields, approvalKey);
  if (res.status >= 300) {
    const parsed = res.json as Record<string, unknown> | null;
    log.error(String(parsed?.["message"] ?? `HTTP ${res.status}`));
    if (parsed?.["code"] === "approval_required" && typeof parsed["approvalKey"] === "string") {
      log.warn(`This is a destructive operation. A human must approve it, then re-run:`);
      log.raw(`  a2app run ${dir} ${opName} --approve ${parsed["approvalKey"]}`);
    }
    return 1;
  }
  log.raw(res.body || `(HTTP ${res.status}, ok)`);
  return 0;
}
