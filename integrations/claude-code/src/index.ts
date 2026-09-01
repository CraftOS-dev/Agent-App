#!/usr/bin/env node
/**
 * Agent App Framework MCP server for Claude Code (and any MCP client).
 *
 * Claude Code consumes tools over the Model Context Protocol. This is a real MCP
 * server (stdio transport, newline-delimited JSON-RPC 2.0) that exposes the
 * framework engine's build+operate tools — so an agent in Claude Code can build,
 * evolve, and operate Agent Apps. Every tool shells the real `a2app` CLI through
 * the shared engine (`@a2app/integration-starter`); nothing here is simulated.
 *
 * Register with:  claude mcp add a2app -- node <path>/dist/index.js
 * Override the CLI binary with the A2APP_CLI env var (default: `a2app`).
 */
import { createInterface } from "node:readline";
import { a2appTools, type HarnessTool } from "@a2app/integration-starter";

const CLI = process.env.A2APP_CLI ?? "a2app";
const SERVER_INFO = { name: "a2app", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const tools: HarnessTool[] = a2appTools(CLI);
const byName = new Map(tools.map((t) => [t.name, t]));

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
      const text = r.stdout.trim() || r.stderr.trim() || `exit ${r.code}`;
      // A guard rejection (exit 1) is a valid, useful result the model acts on —
      // only an unreachable/crashed CLI (exit 3 or spawn failure) is an MCP error.
      return ok(id, { content: [{ type: "text", text }], isError: r.code === 3 || r.code < 0 });
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
