/** Wire-level app for the delivery test; launched by `serve`, not by the test
 * runner. Its queue lives in state.json beside it, so work survives stop/serve
 * and the test can seed tasks while the app is down. Every write is atomic
 * (temp file + rename) and every read retries, because the test and this server
 * both touch that file and Windows refuses to open a file mid-rename. */
import { createServer } from "node:http";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stateFile = fileURLToPath(new URL("./state.json", import.meta.url));
const requestsFile = fileURLToPath(new URL("./requests.jsonl", import.meta.url));
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt >= 40) throw err;
      pause(10);
    }
  }
}
const read = () => retry(() => JSON.parse(readFileSync(stateFile, "utf8")));
const save = (state) => {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  retry(() => renameSync(tmp, stateFile));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  appendFileSync(requestsFile, JSON.stringify({ path: url.pathname, method: req.method, credential: !!req.headers["x-a2app-token"] }) + "\n");
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const state = read();
  const path = url.pathname;
  const appId = state.appId ?? "delivery_test";
  if (path === "/api/_a2app" || path === "/.well-known/a2app.json") {
    return send(200, { a2app: true, protocol: "0.1", adapterVersion: "0.1.0", app: { id: appId, name: "Delivery Test" } });
  }
  if (path === "/api/_a2app/describe") {
    return send(200, { a2app: true, level: "root", app: { id: appId, name: "Delivery Test" }, modules: [], next: [] });
  }
  if (path === "/api/_a2app/tasks") {
    const status = url.searchParams.get("status");
    if (state.queueMode === "forbidden") return send(401, { code: "unauthorized" });
    if (state.queueMode === "malformed") return send(200, { notTasks: [] });
    if (state.queueMode === "bad-task") return send(200, { tasks: [null] });
    if (state.queueMode === "hang") return;
    if (state.queueMode === "hang-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"tasks":');
      return;
    }
    // Like the real adapter: no status means every task, whatever its state.
    const tasks = status === null ? state.tasks : state.tasks.filter((t) => t.status === status);
    // An unfiltered history past the status probe's size cap.
    const padding = state.queueMode === "huge" && status === null ? "x".repeat(1100 * 1024) : undefined;
    return send(200, { a2app: true, tasks, pollAfterMs: 100, ...(padding ? { padding } : {}) });
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
      task.status = body.status;
      task.result = body.result ?? null;
      task.reason = body.reason ?? null;
    } else return send(404, { code: "usage" });
    task.updatedAt = new Date().toISOString();
    save(state);
    return send(200, task);
  }
  send(404, { code: "usage" });
});
server.listen(Number(process.env.PORT), "127.0.0.1");
