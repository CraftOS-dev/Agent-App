/**
 * Where an app listens, and the address the rest of the world uses for it.
 *
 * An app binds loopback unless its owner says otherwise (`A2APP_HOST`), and
 * answers to the names in its own origins plus the host of `A2APP_PUBLIC_URL`.
 * The one rule enforced here: a bearer token must never cross a network in
 * clear. Binding a non-loopback address therefore needs an https public URL,
 * and a public URL may be plain http only when it names this machine (an SSH
 * tunnel ends on loopback).
 */
import { isIPv4 } from "node:net";

/** Is `hostname` a loopback name or address? Accepts a bracketed IPv6 literal. */
export function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name === "::1" || name === "[::1]") return true;
  return isIPv4(name) && name.split(".")[0] === "127";
}

/** The host name in a `Host` header value (`name`, `name:port`, `[v6]:port`),
 *  or null when it is not one. */
export function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface NetworkPolicy {
  /** the address to bind */
  host: string;
  /** the origin people and agents reach the app at, or null when only loopback */
  publicUrl: string | null;
}

/**
 * Resolve the bind address and public URL from the environment, or throw with
 * the reason the combination is unsafe. Call it before binding anything.
 */
export function networkPolicy(env: { host?: string | undefined; publicUrl?: string | undefined }): NetworkPolicy {
  const host = env.host?.trim() || "127.0.0.1";
  let publicUrl: URL | null = null;
  const raw = env.publicUrl?.trim();
  if (raw) {
    try {
      publicUrl = new URL(raw);
    } catch {
      throw new Error(`A2APP_PUBLIC_URL is not a URL: "${raw}".`);
    }
    if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
      throw new Error(`A2APP_PUBLIC_URL must be an http(s) URL, not "${raw}".`);
    }
    if (publicUrl.protocol === "http:" && !isLoopbackName(publicUrl.hostname)) {
      throw new Error(
        `A2APP_PUBLIC_URL must be https: "${raw}" would send the agent token across a network in clear. ` +
          `Put the app behind a TLS proxy, or reach it through an SSH tunnel to a loopback address.`,
      );
    }
  }
  if (!isLoopbackName(host) && publicUrl?.protocol !== "https:") {
    throw new Error(
      `A2APP_HOST=${host} exposes the app to the network, so A2APP_PUBLIC_URL must name its https address ` +
        `(the agent token must not cross a network in clear). To reach it through a tunnel instead, keep A2APP_HOST on 127.0.0.1.`,
    );
  }
  return { host, publicUrl: publicUrl ? publicUrl.origin : null };
}
