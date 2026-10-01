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
import { a2appTools, PROMPT_PLACEHOLDER, registerHarnessProfile, type HarnessTool } from "@a2app/integration-starter";

const CLI = process.env.A2APP_CLI ?? "a2app";
// Build/evolve lives in a second binary (framework spec 5.1); the engine routes
// each verb to the right one.
const FRAMEWORK_CLI = process.env.AGENT_APP_CLI ?? "agent-app";
const SERVER_INFO = { name: "a2app", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

const tools: HarnessTool[] = a2appTools(CLI, FRAMEWORK_CLI);
const byName = new Map(tools.map((t) => [t.name, t]));

// How `agent-app <dir> bridge` starts Claude Code when an app queues work. The
// framework's built-in `claude -p` profile passes no permission flags, and in
// print mode every Bash call that would prompt is denied — so the agent could
// not run a single `a2app` command, would exit 0, and the bridge would record
// the task as completed. This profile, under the same id, replaces the built-in:
// `dontAsk` denies anything not listed instead of prompting, and the one listed
// rule lets the agent operate the app through the a2app CLI and nothing else.
// Written once; an entry already in the file (the user's own) is kept.
const registration = registerHarnessProfile({
  id: "claude",
  name: "Claude Code",
  routes: [
    {
      mode: "headless",
      command: "claude",
      args: ["-p", PROMPT_PLACEHOLDER, "--permission-mode", "dontAsk", "--allowedTools", "Bash(a2app *)"],
    },
  ],
});
// stdout carries JSON-RPC, so anything said here goes to stderr.
if (registration.status !== "kept") process.stderr.write(`a2app: ${registration.detail}\n`);

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
