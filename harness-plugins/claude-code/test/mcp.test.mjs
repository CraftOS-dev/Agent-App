/**
 * The MCP server as Claude Code drives it: newline-delimited JSON-RPC 2.0 on
 * stdio, against the starter's fake CLIs (copied as `agent-app.mjs` and
 * `a2app.mjs`) in a throwaway framework home.
 *
 * Pinned: the server offers the engine's whole tool set, a call reaches the
 * CLI with the tool's argv, and every non-zero exit is reported as `isError`
 * with the CLI's own words still in the text.
 *
 * Runs against the compiled server (`dist/`), standard library only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = mkdtempSync(join(tmpdir(), "a2app-mcp-"));
for (const name of ["agent-app", "a2app"]) copyFileSync(resolve(here, "../../integration-starter/test/fake-cli.mjs"), join(base, `${name}.mjs`));

const server = spawn(process.execPath, [resolve(here, "../dist/index.js")], {
  env: { ...process.env, A2APP_HOME: join(base, "home"), A2APP_CLI: join(base, "a2app.mjs"), AGENT_APP_CLI: join(base, "agent-app.mjs") },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const waiting = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  waiting.get(msg.id)?.(msg);
  waiting.delete(msg.id);
});
let next = 1;
function rpc(method, params) {
  const id = next++;
  return new Promise((done) => {
    waiting.set(id, done);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const callTool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;

try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.serverInfo.name, "a2app");

  const { tools } = (await rpc("tools/list", {})).result;
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 22);
  for (const name of ["agent_app_catalogue", "agent_app_inspect", "agent_app_install", "agent_app_export", "agent_app_list_apps"]) {
    assert.ok(names.includes(name), `Claude Code gets ${name}`);
  }
  assert.ok(tools.every((t) => t.inputSchema.type === "object"));

  let r = await callTool("agent_app_install", { id: "kanban-board", set: { APP_TITLE: "Team" }, noStart: true });
  assert.equal(r.isError, false);
  const result = JSON.parse(r.content[0].text);
  assert.deepEqual([result.trust, result.argv], ["catalogued", ["install", "kanban-board", "--set", "APP_TITLE=Team", "--no-start"]]);

  r = await callTool("agent_app_install", { id: "kanban-board", from: "./board.zip" });
  assert.equal(r.isError, true, "a usage error (exit 2) is an error");
  assert.match(r.content[0].text, /not both/, "with the CLI's message");

  r = await callTool("agent_app_install", { from: "./living-ui-app" });
  assert.equal(r.isError, true, "a refused install (exit 1) is an error");
  const refusal = JSON.parse(r.content[0].text);
  assert.deepEqual([refusal.step, refusal.routes], ["inspect", ["convert"]], "and still carries where to take the source");

  r = await callTool("agent_app_update", { dir: "crm", entity: "deals", id: "BAD", fields: {} });
  assert.equal(r.isError, true, "a guard rejection (exit 1) is an error");
  assert.match(r.content[0].text, /rejected by the guard/);

  r = await callTool("agent_app_catalogue", { source: "unreachable" });
  assert.equal(r.isError, true, "an unreachable marketplace (exit 3) is an error");

  const unknown = await rpc("tools/call", { name: "agent_app_nope", arguments: {} });
  assert.equal(unknown.error.code, -32602);
} finally {
  server.kill();
  await new Promise((r) => server.on("close", r));
  rmSync(base, { recursive: true, force: true });
}

console.log("✓ mcp: 22 tools over JSON-RPC; calls reach the CLI with their argv; every non-zero exit is isError, with the CLI's words");
