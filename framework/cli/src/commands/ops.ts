/** a2app <app> ops — list the app's declared operations (its agent verbs). */
import { clientFor, loadProject } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const client = await clientFor(loadProject(app));
  const described = await client.describe();
  if (described === null) {
    log.error("describe unavailable — is the app running and does it carry an adapter?");
    return 1;
  }
  log.raw(JSON.stringify(described.operations ?? [], null, 2));
  return 0;
}
