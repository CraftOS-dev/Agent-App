/** a2app <app> whoami — the calling credential's grant. */
import { connect } from "../lib/target.js";
import { log } from "../lib/log.js";

export async function run(_args: string[], app: string): Promise<number> {
  const { client } = await connect(app);
  const who = await client.whoami();
  if (who === null) {
    log.error("whoami unavailable (adapter predates IAM, or credential rejected)");
    return 1;
  }
  log.raw(JSON.stringify(who, null, 2));
  return 0;
}
