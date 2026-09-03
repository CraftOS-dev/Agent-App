/** a2app <app> identity — probe the app's identity document. */
import { clientFor, loadProject } from "../lib/project.js";
import { A2AppClient } from "@a2app/sdk";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const client = await clientFor(project);
  const id = await client.identity();
  if (id === null) {
    log.error("Not an A2App app (no `a2app: true` marker at /.well-known/a2app.json or /api/_a2app)");
    return 1;
  }
  log.raw(JSON.stringify(id, null, 2));
  if (!A2AppClient.protocolSupported(id.protocol)) {
    log.warn(`protocol "${id.protocol}" is not recognised by this client — do not write`);
  }
  return 0;
}
