/** Wire-level app for the delivery lifecycle test; launched by serve, not by
 * the test runner. State survives stop/serve so later work can be delivered. */
import { createServer } from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const stateFile = new URL("./state.json", import.meta.url);
const requestsFile = new URL("./requests.jsonl", import.meta.url);
const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
const save = (state) => writeFileSync(stateFile, JSON.stringify(state));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  appendFileSync(requestsFile, JSON.stringify({ path: url.pathname, method: req.method, credential: !!req.headers["x-a2app-token"] }) + "\n");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const state = read();
  const path = url.pathname;
  if (path === "/api/_a2app" || path === "/.well-known/a2app.json") {
    return send(200, { a2app: true, protocol: "0.1", adapterVersion: "0.1.0", app: { id: state.appId ?? "delivery_test", name: "Delivery Test" } });
  }
  if (path === "/api/_a2app/describe") {
    return send(200, { a2app: true, level: "root", app: { id: "delivery_test", name: "Delivery Test" }, modules: [], next: [] });
  }
  if (path === "/api/_a2app/tasks") {
    if (state.queueMode === "forbidden") return send(401, { code: "unauthorized" });
    if (state.queueMode === "malformed") return send(200, { notTasks: [] });
    if (state.queueMode === "bad-task") return send(200, { tasks: [null] });
    if (state.queueMode === "hang") return;
    if (state.queueMode === "hang-body") {
      res.writeHead(200, { "content-type": "application/json" }); res.write('{"tasks":'); return;
    }
    return send(200, { a2app: true, tasks: state.tasks.filter((t) => t.status === (url.searchParams.get("status") ?? "submitted")), pollAfterMs: 100 });
  }
  if (path.startsWith("/api/_a2app/tasks/")) {
    const [id, action] = path.slice("/api/_a2app/tasks/".length).split("/");
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return send(404, { code: "task_not_found" });
    if (!action) return send(200, task);
    if (action === "claim") {
      if (task.status !== "submitted") return send(409, { code: "task_not_claimable" });
      task.status = "working";
      task.claim = { credentialId: "delivery_test", principal: "owner", claimedAt: new Date().toISOString() };
    } else if (action === "progress") {
      if (task.status !== "working") return send(409, { code: "task_not_claimable" });
      task.progress = { ...task.progress, ...body };
    } else if (action === "complete") {
      if (task.status !== "working") return send(409, { code: "task_not_claimable" });
      task.status = body.status; task.result = body.result ?? null; task.reason = body.reason ?? null;
    } else return send(404, { code: "usage" });
    task.updatedAt = new Date().toISOString(); save(state); return send(200, task);
  }
  send(404, { code: "usage" });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
