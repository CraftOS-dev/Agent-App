/**
 * agent-app <dir> owner — a one-time setup link for an OWNER account on a
 * multi-user app: how the first owner is created (spec/v0_2/auth.md §4).
 * Same as `agent-app <dir> invite --role owner`.
 */
import { invite } from "./invite.js";

export async function run(args: string[], app: string): Promise<number> {
  return invite(args, app, "owner");
}
