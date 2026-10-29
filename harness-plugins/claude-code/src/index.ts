#!/usr/bin/env node
/**
 * Agent App Framework MCP server for Claude Code (and any MCP client).
 *
 * Claude Code consumes tools over the Model Context Protocol. This is a real MCP
 * server (stdio transport, newline-delimited JSON-RPC 2.0) that exposes the
 * framework engine's build+operate tools — so an agent in Claude Code can build,
 * evolve, and operate Agent Apps. Every tool shells a real framework CLI through
 * the shared engine (`@a2app/integration-starter`); nothing here is simulated.
 *
 * Register with:  claude mcp add a2app -- node <path>/dist/index.js
 * Override the binaries with A2APP_CLI (operate, default `a2app`) and
 * AGENT_APP_CLI (build/evolve, default `agent-app`).
 */
import { createInterface } from "node:readline";
import { a2appTools, type HarnessTool } from "@a2app/integration-starter";

const CLI = process.env.A2APP_CLI ?? "a2app";
// Build/evolve lives in a second binary (framework spec 5.1); the engine routes
// each verb to the right one.
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";
const SERVER_INFO = { name: "a2app", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const tools: HarnessTool[] = a2appTools(CLI, FRAMEWORK_CLI);
const byName = new Map(tools.map((t) => [t.name, t]));

// How `agent-app <dir> bridge` starts Claude Code when an app queues work is the
// framework's built-in `claude` profile (framework/cli/src/lib/harness.ts): it
// grants the a2app CLI and denies file edits. Nothing is registered here — an
// entry in harnesses.json under the same id would replace the built-in for good,
// and keep any later fix to it from ever arriving.

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

function send(msg: JsonRpc): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function ok(id: JsonRpc["id"], result: unknown): JsonRpc {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function fail(id: JsonRpc["id"], code: number, message: string): JsonRpc {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handle(msg: JsonRpc): Promise<JsonRpc | null> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = name ? byName.get(name) : undefined;
      if (!tool) return fail(id, -32602, `unknown tool: ${name}`);
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      const r = await tool.handler(args);
      // The CLI's own words reach the model either way: its result document, and
      // when it failed, what it said on stderr (a usage error prints only that).
      const out = r.stdout.trim();
      const err = r.stderr.trim();
      const text = (r.ok ? out || err : [out, err].filter((s) => s !== "").join("\n")) || `exit ${r.code}`;
      // Any non-zero exit is a failed call (1 rejected, 2 usage, 3 unreachable,
      // or the CLI could not start): `isError` tells the client so, and the text
      // still carries what the model needs to act on it.
      return ok(id, { content: [{ type: "text", text }], isError: r.code !== 0 });
    }
    default:
      return id === undefined || id === null ? null : fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: JsonRpc;
  try {
    msg = JSON.parse(trimmed) as JsonRpc;
  } catch {
    return; // ignore non-JSON lines
  }
  void handle(msg).then((res) => {
    if (res) send(res);
  });
});
