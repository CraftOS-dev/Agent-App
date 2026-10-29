/**
 * A foreign app to adopt: a plain Node HTTP server with two routes, no
 * framework files and no adapter. It knows nothing about A2App.
 *
 *   GET  /notes[?q=…]   the notes, or those containing q
 *   POST /notes         { "text": "…" } → the stored note
 *
 * It binds loopback on PORT, like most apps of its kind.
 */
import { createServer } from "node:http";

const notes = [];

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const url = new URL(req.url ?? "/", "http://notes-app");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/notes" && req.method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    return send(200, notes.filter((n) => n.text.includes(q)));
  }
  if (url.pathname === "/notes" && req.method === "POST") {
    let text;
    try {
      text = JSON.parse(raw).text;
    } catch {
      return send(400, { error: "body must be JSON" });
    }
    if (typeof text !== "string" || text === "") return send(422, { error: "text is required" });
    const note = { id: notes.length + 1, text, createdAt: new Date().toISOString() };
    notes.push(note);
    return send(201, note);
  }
  return send(404, { error: "not found" });
}).listen(Number(process.env.PORT), "127.0.0.1");
