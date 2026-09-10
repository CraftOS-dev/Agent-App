/**
 * What an operate command is pointed at: an app on this machine, or one reached
 * over the network.
 *
 * The framework's two binaries already draw the line this file needs. `agent-app`
 * builds and evolves an app and cannot do any of that without its files;
 * `a2app` operates a running app and needs nothing but a URL and a credential.
 * Connect — operating an app you do not own — is therefore not a new mode. It is
 * `a2app` pointed somewhere else.
 *
 * So the boundary is made structural rather than documented. A {@link Target} is
 * local or remote; only the local one carries a `dir`, and `loadProject` — which
 * every build and lifecycle command calls — returns only that. A framework
 * command handed a URL does not reach a runtime check that refuses it; there is
 * no directory for it to compile against. "Operated but never modified" stops
 * being a rule an agent has to keep and becomes one it cannot break.
 */
import { A2AppClient } from "@a2app/sdk";
import { clientFor, isRemoteAddress, loadProject, UsageError, type Project } from "./project.js";
import { credentialFor, originOf, pinAppId, pinnedAppId } from "./remote.js";
import { homePath } from "./home.js";
import { log } from "./log.js";

/** An app on this machine: its files are here, so anything may be done to it. */
export interface LocalTarget {
  kind: "local";
  baseUrl: string;
  project: Project;
}

/** An app reached over the network: operate only, and identity is not assumed. */
export interface RemoteTarget {
  kind: "remote";
  baseUrl: string;
  origin: string;
  /** what this origin is pinned to, when it has been reached before */
  expectedAppId: string | null;
  /** filled in once identity has been verified; null before that */
  appId: string | null;
  appName: string | null;
}

export type Target = LocalTarget | RemoteTarget;

/**
 * Where this target's describe cache lives.
 *
 * A local app keeps it beside its own files. A remote app has none here, so it
 * gets a directory under the framework home keyed by origin. The cache itself
 * needs no changes for either: it already discards a file whose `appId` is not
 * the one being asked for, so a slug collision between two origins costs a
 * re-fetch and can never serve one app's model for another.
 */
export function cacheDirFor(target: Target): string {
  if (target.kind === "local") return target.project.dir;
  return homePath("remote", target.origin.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, ""));
}

/** What to call this app in output meant for a person to read. */
export function labelFor(target: Target): string {
  if (target.kind === "local") return target.project.manifest.name;
  return target.appName ?? target.appId ?? target.origin;
}

/**
 * Resolve what `app` addresses.
 *
 * A URL is unambiguous — no directory and no registered app name begins with
 * `http://` — so no guessing is involved and the local path is untouched.
 */
export function resolveTarget(app: string): Target {
  if (isRemoteAddress(app)) {
    const baseUrl = app.replace(/\/+$/, "");
    const origin = originOf(baseUrl);
    return { kind: "remote", baseUrl, origin, expectedAppId: pinnedAppId(origin), appId: null, appName: null };
  }
  const project = loadProject(app);
  return { kind: "local", baseUrl: project.baseUrl, project };
}

/**
 * Say why the identity document did not arrive.
 *
 * `identity()` reports absence, not cause — it returns null for a 404, a 403 and
 * a page of HTML alike, because from the protocol's side those are the same
 * answer. For a remote app they are not the same problem, and one of them is
 * both common and completely opaque if reported as "not an Agent App":
 *
 * An adapter answers only on hosts it recognises. Deployed behind a proxy or a
 * tunnel, the app receives its PUBLIC hostname in `Host` and refuses it with
 * `forbidden_host` unless its own config lists that name. The app is running,
 * it is reachable, and it is an Agent App — it has not been told what it is
 * called. That is the owner's fix, and an agent that is told "not an Agent App"
 * will go looking for a different URL instead of reporting it.
 *
 * So the failing response is read once, on the failure path only, to name the
 * cause. Diagnosis never changes what is refused: nothing here makes a request
 * succeed that did not.
 */
async function noIdentity(target: RemoteTarget): Promise<UsageError> {
  const generic = new UsageError(
    `Not an Agent App: ${target.origin} did not return the \`a2app: true\` marker at ` +
      `/.well-known/a2app.json or /api/_a2app.`,
  );
  try {
    const res = await fetch(`${target.baseUrl}/api/_a2app`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return generic;
    const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
    if (res.status === 403 && body?.code === "forbidden_host") {
      return new UsageError(
        `${target.origin} is an Agent App, but it does not answer to that hostname.\n` +
          `It replied ${res.status} forbidden_host: an adapter serves only the hosts it is configured for, ` +
          `and a deployed app receives its public hostname in \`Host\`.\n` +
          `This is the owner's to fix — the app's adapter needs "${new URL(target.baseUrl).host}" in its ` +
          `allowedHosts (or an allowedOrigins entry carrying it). Nothing you can send will change the answer.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      return new UsageError(
        `${target.origin} refused the identity document (${res.status}${body?.code ? ` ${body.code}` : ""}).\n` +
          `That document is unauthenticated by design, so a refusal here is the host in front of the app — ` +
          `a proxy, a tunnel's own auth, or a login page — not the app's own access control.`,
      );
    }
    return generic;
  } catch {
    // The probe is a courtesy. If it cannot run, the original answer stands.
    return generic;
  }
}

/**
 * Verify a remote app's identity before anything is said to it.
 *
 * This is the gate the connect skill calls step 38, and it runs here rather than
 * in each command so that no operate path can reach a remote app without having
 * passed it. Three checks, in the order that makes each one meaningful:
 *
 *  1. the `a2app: true` marker — otherwise this is some other server, and the
 *     fields below would be read out of a document that does not mean them.
 *  2. the protocol version — an unrecognised one means the guarantees this client
 *     relies on are not the guarantees being offered, so nothing is read and
 *     nothing is written.
 *  3. `app.id` against the pin — the first id an origin returns is the one it is
 *     expected to keep. A changed id is reported, never followed: the failure
 *     that matters here is operating a different app than the one intended,
 *     which looks exactly like success until it does not.
 */
async function verifyRemote(client: A2AppClient, target: RemoteTarget): Promise<void> {
  const id = await client.identity();
  if (id === null) throw await noIdentity(target);
  if (!A2AppClient.protocolSupported(id.protocol)) {
    throw new UsageError(
      `Unsupported protocol "${id.protocol}" at ${target.origin}. This client speaks 0.1; ` +
        `nothing will be read or written over a protocol it does not recognise.`,
    );
  }
  const appId = id.app?.id;
  if (typeof appId !== "string" || appId === "") {
    throw new UsageError(`${target.origin} returned an identity document with no \`app.id\`.`);
  }
  if (target.expectedAppId !== null && target.expectedAppId !== appId) {
    throw new UsageError(
      `${target.origin} now identifies as "${appId}", but was pinned to "${target.expectedAppId}".\n` +
        `Refusing to operate a different app than the one this origin was known for. ` +
        `If the change is expected, remove its entry from the known-apps file and run this again.`,
    );
  }
  target.appId = appId;
  target.appName = id.app?.name ?? null;
  if (target.expectedAppId === null) {
    // First contact. Nothing is being trusted here that was not already trusted
    // by being pointed at this URL — the pin only makes a LATER change visible.
    log.warn(`First contact with ${target.origin} — pinning app.id "${appId}".`);
    await pinAppId(target.origin, appId);
  }
}

/**
 * An A2App client for a target, verified and credentialled.
 *
 * A remote target is verified first and always: an agent that reads a describe
 * before checking what answered has already acted on an unknown app.
 */
export async function clientForTarget(target: Target): Promise<A2AppClient> {
  if (target.kind === "local") return clientFor(target.project);

  const { token, authToken } = credentialFor(target.origin, target.expectedAppId, (m) => log.warn(m));
  const client = new A2AppClient({
    baseUrl: target.baseUrl,
    token,
    agentName: process.env["A2APP_AGENT"] ?? "a2app-cli",
    authToken,
  });
  await verifyRemote(client, target);
  return client;
}

/** Resolve and connect in one step — what every operate command does. */
export async function connect(app: string): Promise<{ target: Target; client: A2AppClient }> {
  const target = resolveTarget(app);
  return { target, client: await clientForTarget(target) };
}
