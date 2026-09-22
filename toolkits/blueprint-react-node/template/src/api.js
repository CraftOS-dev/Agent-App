/**
 * One fetch wrapper for the whole View (AGENT-OWNED): 10 s timeout on every
 * call, JSON in and out, and errors surfaced as messages a screen can show.
 * Idempotent GETs retry once on network failure with a short jittered delay;
 * writes never retry (the UI disables the control instead, so a retry is the
 * user's call).
 */
export async function api(path, init = {}, { retryGet = true } = {}) {
  const isGet = !init.method || init.method === "GET";
  try {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      ...init,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message = json?.message ?? `The app answered with an error (HTTP ${res.status}).`;
      throw Object.assign(new Error(message), { status: res.status });
    }
    return json;
  } catch (err) {
    if (isGet && retryGet && !(err && "status" in err)) {
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
      return api(path, init, { retryGet: false });
    }
    if (err?.name === "TimeoutError") throw new Error("The app took too long to answer.");
    if (err instanceof TypeError) throw new Error("The app is not reachable right now.");
    throw err;
  }
}
