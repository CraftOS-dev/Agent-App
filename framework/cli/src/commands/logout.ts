/**
 * a2app <app> logout — revoke this agent's stored credential for the app and
 * forget it. The app is told first, so the token is dead even if a copy of
 * credentials.json survives somewhere; then the entry is removed.
 */
import { A2AppClient } from "@a2app/sdk";
import { log } from "../lib/log.js";
import { forgetCredential, readCredentials } from "../lib/remote.js";
import { loginTarget } from "./login.js";

export async function run(_args: string[], app: string): Promise<number> {
  const { client, origin, appId, name } = await loginTarget(app);
  const stored = readCredentials().find((c) => c.origin === origin && c.appId === appId);
  if (!stored) {
    log.info(`no stored credential for ${name}: nothing to log out of.`);
    return 0;
  }
  if (stored.credentialId) {
    const self = new A2AppClient({ baseUrl: client.baseUrl, token: stored.token, agentName: "a2app-logout" });
    const res = await self.request("DELETE", `/api/_a2app/credentials/${encodeURIComponent(stored.credentialId)}`);
    const code = (res.json as { code?: string } | null)?.code;
    // Already dead is as good as revoked: either way the token works no more.
    if (res.status !== 200 && code !== "credential_revoked" && code !== "token_expired" && code !== "credential_invalid") {
      log.error(`${name} did not revoke the credential (${res.status}${code ? ` ${code}` : ""}); it is kept so you can try again.`);
      return 1;
    }
  }
  await forgetCredential(origin, appId);
  log.ok(`logged out of ${name}: the credential is revoked and forgotten.`);
  return 0;
}
