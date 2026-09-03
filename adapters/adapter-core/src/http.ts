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

/** Max accepted request body (5 MiB). A protocol write is tiny; anything larger
 *  is a mistake or an attack, and buffering it whole would let a hostile client
 *  OOM the app. Rejected with a 413-style envelope. */
export const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

/** Once over the cap we stop buffering but keep draining (discarding) so the 413
 *  reaches a client still uploading — up to this hard ceiling of total bytes
 *  seen, past which the upload is abusive and the socket is torn down. */
const HARD_READ_CEILING_BYTES = MAX_REQUEST_BODY_BYTES * 4;

/** Thrown by {@link readBody} when the request body exceeds the cap. */
class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds the ${limit}-byte limit.`);
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  // Enforce the cap byte-by-byte, so neither a missing nor a lying Content-Length
  // can slip a huge body past. Once over the cap we DROP the buffer (memory stays
  // bounded — no OOM) and drain the rest so the caller's 413 is delivered rather
  // than racing a socket close; a body past the hard ceiling is abusive, so we
  // destroy the socket and reject.
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (!over && total > MAX_REQUEST_BODY_BYTES) {
      over = true;
      chunks.length = 0; // release what we buffered; stop keeping bytes
    }
    if (over) {
      // Past the hard ceiling the upload is abusive: stop reading. The caller's
      // 413 carries `Connection: close`, so Node tears the socket down after the
      // response flushes — no explicit socket.destroy() (which races libuv
      // teardown on win32).
      if (total > HARD_READ_CEILING_BYTES) break;
      continue; // drain-and-discard so the 413 reaches a still-uploading client
    }
    chunks.push(buf);
  }
  if (over) throw new BodyTooLargeError(MAX_REQUEST_BODY_BYTES);
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
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          // Close the connection after answering: the client may still be
          // uploading the (rejected) body, and there is no point reading it.
          res.writeHead(413, { "content-type": "application/json", connection: "close" });
          res.end(
            JSON.stringify({
              a2app: true,
              ok: false,
              code: "payload_too_large",
              message: e.message,
              limitBytes: e.limit,
            }),
          );
          return;
        }
        throw e;
      }
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
