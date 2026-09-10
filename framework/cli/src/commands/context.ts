/** a2app <app> context — what the user is currently viewing. */
import { connect } from "../lib/target.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const { client } = await connect(app);
  const ctx = await client.context();
  if (ctx === null) {
    log.error("context surface unavailable (adapter has not implemented /api/_a2app/context)");
    return 1;
  }
  log.raw(JSON.stringify(ctx, null, 2));
  return 0;
}
