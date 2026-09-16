/**
 * Network helpers for the framework CLI.
 *
 * Every outbound probe MUST be bounded: a bare `fetch` against a port that
 * accepts the connection but never answers hangs the whole command forever, so
 * a health poll's time budget is only real if each request can be aborted. The
 * registry's `identify()` already does this; `serve`/`stop`/`dev`/`promote`
 * reuse this helper so the behaviour is uniform.
 */

/** `fetch` with a hard per-request deadline via AbortController. */
export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask whoever holds a local port to identify itself as an A2App app.
 * Returns the app id, or null when the responder is not this protocol (or is
 * unreachable). This is what separates "my app is running" from "some other
 * process took the port" — used by serve/stop before they act on a port.
 */
/**
 * How many people currently have this app open in a browser.
 *
 * The app itself is the only thing that can know: a loaded page is invisible to
 * this process, so the page reports itself as it polls and the adapter keeps a
 * count. Returns null when the app cannot answer — an older adapter with no
 * `/viewers` route, no credential, or an unreachable app — which callers must
 * treat as "unknown", never as "nobody". Guessing "nobody" would open a browser
 * over someone's work; guessing "somebody" would leave them staring at a stale
 * tab that never arrives.
 */
export async function countViewers(
  port: number,
  token: string | null,
  timeoutMs = 1500,
): Promise<number | null> {
  if (token === null) return null;
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/_a2app/viewers`, timeoutMs, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { viewers?: unknown };
    return typeof body.viewers === "number" ? body.viewers : null;
  } catch {
    return null;
  }
}

/** Poll a health URL until it answers 2xx or the deadline passes. Shared by
 *  `serve` and `dev`, which launch the same pipeline against different ports. */
export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(url, 2000);
      if (res.ok) return true;
    } catch {
      /* not up yet, or this probe timed out — keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * A free loopback port, assigned by the OS (bind port 0, read the number,
 * release). Used for the dev instance's hidden port: nothing needs to predict
 * it — every consumer reads it from the dev record — so the ephemeral range is
 * exactly right, and it can never collide with the registered app range. The
 * tiny window between release and the app's own bind is closed by the health
 * check + identity probe that follow the launch: a stolen port fails loudly.
 */
export async function freeEphemeralPort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("could not allocate a port")));
        return;
      }
      const port = address.port;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function identifyApp(port: number, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/_a2app`, timeoutMs);
    if (!res.ok) return null;
    const body = (await res.json()) as { a2app?: boolean; app?: { id?: string } };
    if (body?.a2app !== true) return null;
    return typeof body.app?.id === "string" ? body.app.id : null;
  } catch {
    return null;
  }
}
