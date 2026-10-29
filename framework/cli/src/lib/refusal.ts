/**
 * Saying why an app refused a request, in its own words: the error code first,
 * because an agent's next step depends on it (an expired credential is signed
 * in again, a revoked one is reported, an inactive person stops the work),
 * then the app's `how` hint when it gave one.
 */
import type { A2AppClient, A2AppResponse } from "@a2app/sdk";
import { log } from "./log.js";

/** Report a refused response on stderr. */
export function reportRefusal(res: A2AppResponse, what: string): void {
  const body = res.json as { code?: unknown; message?: unknown; how?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message : `HTTP ${res.status}`;
  log.error(typeof body?.code === "string" ? `${body.code}: ${message}` : `${what} answered HTTP ${res.status}`);
  if (typeof body?.how === "string") log.info(body.how);
}

/** The app's refusal of this caller, when it refuses one: probed with the
 *  caller's own credential on the cheapest route every app serves. */
export async function callerRefused(client: A2AppClient): Promise<A2AppResponse | null> {
  const res = await client.request("GET", "/api/_a2app/whoami");
  return res.status === 401 || res.status === 403 ? res : null;
}
