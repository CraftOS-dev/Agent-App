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
  if (id === null) {
    throw new UsageError(
      `Not an Agent App: ${target.origin} did not return the \`a2app: true\` marker at ` +
        `/.well-known/a2app.json or /api/_a2app.`,
    );
  }
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
