/**
 * Reaching an Agent App that is not on this machine — the credential it is
 * operated with, and the identity it is held to.
 *
 * A local app is addressed through its own directory: the manifest says who it
 * is and `.agent-token` sits beside it, so both questions are answered by the
 * filesystem. A remote app has neither. What replaces them:
 *
 *  - the CREDENTIAL comes from the environment or a user-level store, never from
 *    the app. An app that could tell an agent how to authenticate to it could
 *    tell it to authenticate to something else.
 *  - the IDENTITY is pinned on first contact. There is no directory to disagree
 *    with, so the first `app.id` an origin returns becomes the one it is expected
 *    to keep returning, and a change is surfaced rather than followed.
 *
 * Neither store is required: an agent handed `A2APP_TOKEN` for a single app
 * needs no file at all.
 */
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { homePath, writeFileAtomic } from "./home.js";
import { withHomeLock } from "./lock.js";
import { EnvError } from "./project.js";

export const CREDENTIALS_FILE = "credentials.json";
export const KNOWN_APPS_FILE = "known-apps.json";
export const CREDENTIALS_VERSION = 1;
export const KNOWN_APPS_VERSION = 1;

/** One stored agent credential, addressed by the origin it is good for. */
export interface StoredCredential {
  /** scheme + host + port, exactly as {@link originOf} renders it */
  origin: string;
  /** optional: distinguishes two apps served from one origin */
  appId?: string;
  token: string;
  /** optional: the acting user's own auth token on a multi-user app */
  authToken?: string;
}

export interface CredentialStore {
  version: number;
  credentials: StoredCredential[];
}

/** What an origin identified as the first time it was reached. */
export interface KnownApp {
  origin: string;
  appId: string;
  firstSeen: string;
  lastSeen: string;
}

export interface KnownApps {
  version: number;
  apps: KnownApp[];
}

/**
 * The origin of a base URL: scheme, host and port, and nothing else.
 *
 * Credentials and pins are keyed by origin rather than by the URL as typed,
 * so that a trailing slash or a path does not hand the same app two identities.
 */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/* ------------------------------------------------------------- credentials */

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new EnvError(`${file} is not readable JSON. Fix or remove it; nothing else will be guessed from it.`);
  }
}

/**
 * Warn when a credential file is readable by anyone but its owner.
 *
 * Advisory, never fatal: the mode bits are meaningless on Windows, and a hard
 * failure here would lock a user out of their own apps over a filesystem detail.
 * Saying it once is what turns a silent exposure into a decision.
 */
function warnIfWorldReadable(file: string, warn: (message: string) => void): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(file).mode & 0o077;
    if (mode !== 0) {
      warn(`${file} is readable by other users (mode ${(statSync(file).mode & 0o777).toString(8)}); chmod 600 it.`);
      chmodSync(file, 0o600);
    }
  } catch {
    /* advisory only */
  }
}

export function credentialsPath(): string {
  return homePath(CREDENTIALS_FILE);
}

/** Every stored credential. An absent store is an empty one, not an error. */
export function readCredentials(warn?: (message: string) => void): StoredCredential[] {
  const file = credentialsPath();
  if (!existsSync(file)) return [];
  if (warn) warnIfWorldReadable(file, warn);
  const store = readJson<CredentialStore>(file, { version: CREDENTIALS_VERSION, credentials: [] });
  return Array.isArray(store.credentials) ? store.credentials : [];
}

/**
 * The credential to present to `origin`, and the acting user's token with it.
 *
 * Precedence is environment first, store second: `A2APP_TOKEN` is how a harness
 * hands an agent one app for one run, and it must win over whatever the machine
 * happens to remember. Within the store, an entry naming this `appId` beats a
 * bare origin entry, so two apps behind one hostname stay distinguishable.
 */
export function credentialFor(
  origin: string,
  appId: string | null,
  warn?: (message: string) => void,
): { token: string | null; authToken: string | null } {
  const envToken = process.env["A2APP_TOKEN"];
  const envAuth = process.env["A2APP_AUTH_TOKEN"];
  if (envToken && envToken.trim() !== "") {
    return { token: envToken.trim(), authToken: envAuth?.trim() || null };
  }
  const entries = readCredentials(warn).filter((c) => c.origin === origin);
  const match = (appId !== null ? entries.find((c) => c.appId === appId) : undefined) ?? entries.find((c) => !c.appId);
  if (!match) return { token: null, authToken: envAuth?.trim() || null };
  return { token: match.token, authToken: match.authToken ?? envAuth?.trim() ?? null };
}

/* ------------------------------------------------------------------- pins */

export function knownAppsPath(): string {
  return homePath(KNOWN_APPS_FILE);
}

export function readKnownApps(): KnownApp[] {
  const store = readJson<KnownApps>(knownAppsPath(), { version: KNOWN_APPS_VERSION, apps: [] });
  return Array.isArray(store.apps) ? store.apps : [];
}

/** What this origin is expected to identify as, or null the first time. */
export function pinnedAppId(origin: string): string | null {
  return readKnownApps().find((a) => a.origin === origin)?.appId ?? null;
}

/**
 * Record what an origin identified as, under the home lock.
 *
 * Read-modify-write, so it takes the same lock the registry does: each CLI run
 * is its own process, and two agents reaching two apps at once would otherwise
 * drop one of the pins.
 */
export async function pinAppId(origin: string, appId: string): Promise<void> {
  await withHomeLock(() => {
    const apps = readKnownApps();
    const now = new Date().toISOString();
    const existing = apps.find((a) => a.origin === origin);
    if (existing) {
      existing.appId = appId;
      existing.lastSeen = now;
    } else {
      apps.push({ origin, appId, firstSeen: now, lastSeen: now });
    }
    writeFileAtomic(
      knownAppsPath(),
      JSON.stringify({ version: KNOWN_APPS_VERSION, apps } satisfies KnownApps, null, 2) + "\n",
    );
  });
}
