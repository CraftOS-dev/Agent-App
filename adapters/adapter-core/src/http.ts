/**
 * Mount an {@link A2App} surface on a Node http server (embedded-middleware
 * form). This is transport glue only — it parses an incoming request into an
 * {@link A2AppRequest}, calls `handle`, and writes the reply. A request the
 * adapter does not own (`handle` → null) is passed to `next`, so the host app
 * serves its own UI and routes alongside the adapter.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { A2App } from "./server.js";
import type { A2AppRequest } from "./types.js";

export type NextHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { __unparsed__: text };
  }
}

/** Build an A2AppRequest from a Node request (body already parsed). */
export function toA2AppRequest(req: IncomingMessage, body: unknown): A2AppRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = v;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  }
  return {
    method: (req.method ?? "GET").toUpperCase(),
    path: url.pathname,
    query,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/** A connect/node-style middleware for the adapter. */
export function a2appMiddleware(app: A2App): (req: IncomingMessage, res: ServerResponse, next: NextHandler) => void {
  return (req, res, next) => {
    void (async () => {
      const body = await readBody(req);
      const areq = toA2AppRequest(req, body);
      const reply = await app.handle(areq);
      if (reply === null) {
        next(req, res);
        return;
      }
      const headers = { "content-type": "application/json", ...(reply.headers ?? {}) };
      res.writeHead(reply.status, headers);
      res.end(JSON.stringify(reply.json));
    })().catch((e) => {
      // Fail open internally: an adapter bug never 500s the whole app silently —
      // it answers with a machine-readable adapter error.
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ a2app: true, ok: false, code: "adapter_error", message: String((e as Error).message) }));
    });
  };
}

/**
 * A standalone A2App server: the adapter plus an optional fallthrough for the
 * host app's own routes. Handy for the reference app, the conformance harness,
 * and the playground.
 */
export function createA2AppServer(app: A2App, fallthrough?: NextHandler): Server {
  const mw = a2appMiddleware(app);
  return createServer((req, res) => {
    mw(
      req,
      res,
      fallthrough ??
        ((_r, response) => {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ a2app: true, ok: false, code: "not_found", message: "No such route." }));
        }),
    );
  });
}
