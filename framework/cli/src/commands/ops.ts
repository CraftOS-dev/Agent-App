/** a2app ops <dir> — list the app's declared operations (its agent verbs). */
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[]): Promise<number> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (dir === undefined) throw new UsageError("Usage: a2app ops <dir>");
  const client = await clientFor(loadProject(dir));
  const described = await client.describe();
  if (described === null) {
    log.error("describe unavailable — is the app running and does it carry an adapter?");
    return 1;
  }
  log.raw(JSON.stringify(described.operations ?? [], null, 2));
  return 0;
}
