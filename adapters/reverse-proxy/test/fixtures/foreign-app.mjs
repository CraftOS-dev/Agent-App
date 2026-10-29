/**
 * A foreign app, as far as the sidecar knows: a plain Node HTTP server with no
 * framework files and no adapter. It binds PORT, keeps notes in memory, and
 * reports what it was started with (`GET /launch`) so a test can see exactly
 * what the sidecar handed it.
 */
import { createServer } from "node:http";

const notes = [];

/** The variables a test asks about: the ones the sidecar must hand over, and
 *  the ones it must keep to itself. */
const REPORTED_ENV = ["PORT", "GREETING", "NOTES_DIR", "A2APP_TOKEN", "A2APP_DATA_DIR", "A2APP_ENV"];

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url ?? "/", "http://foreign-app");
  const send = (status, json) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };

  if (url.pathname === "/health") return send(200, { ok: true });
  if (url.pathname === "/launch") {
    const env = {};
    for (const name of REPORTED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    return send(200, { argv: process.argv.slice(2), cwd: process.cwd(), env });
  }
  if (url.pathname === "/notes" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return send(200, notes.filter((n) => n.text.includes(q)));
  }
  if (url.pathname === "/notes" && req.method === "POST") {
    const note = { id: String(notes.length + 1), text: JSON.parse(raw || "{}").text };
    notes.push(note);
    return send(201, note);
  }
  return send(404, { error: "no such route" });
});

server.listen(Number(process.env.PORT), "127.0.0.1");
