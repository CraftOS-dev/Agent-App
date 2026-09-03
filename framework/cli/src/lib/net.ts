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
