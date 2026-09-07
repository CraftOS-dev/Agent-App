import { buildReferenceApp } from "./dist/reference-app.js";
import { createA2AppServer } from "@a2app/adapter-core";

const app = buildReferenceApp();
const server = createA2AppServer(app);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
// find the full token
const FULL = "a2app_full_token_for_conformance";
async function req(method, path, body, token = FULL) {
  const r = await fetch(base + path, {
    method,
    headers: { "x-a2app-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}
console.log("LIST", (await req("GET", "/api/data/cards")).text.slice(0, 300));
server.close();
