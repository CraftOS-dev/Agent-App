/** a2app <app> whoami — the calling credential's grant. */
import { connect } from "../lib/target.js";
import { log } from "../lib/log.js";
import { reportRefusal } from "../lib/refusal.js";

export async function run(_args: string[], app: string): Promise<number> {
  const { client, caller } = await connect(app);
  const res = await client.request("GET", "/api/_a2app/whoami");
  if (!res.ok) {
    reportRefusal(res, "whoami", caller);
    return 1;
  }
  log.raw(JSON.stringify(res.json, null, 2));
  return 0;
}
