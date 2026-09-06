/**
 * The reference Agent App the conformance harness drives: a small Kanban board
 * built on `@a2app/adapter-core`'s in-memory binding. It is a conforming A2App
 * app in the embedded-middleware form. The suites in `conformance/suites/*.yaml`
 * assert its behavior over real HTTP + the CLI, so "conformant" is a checkable
 * claim, not a hope.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createA2App,
  createA2AppServer,
  MemoryBinding,
  type A2App,
  type Grant,
} from "@a2app/adapter-core";
import type { NormalizedField } from "@a2app/rules";

const listFields: NormalizedField[] = [
  { name: "title", type: "string", required: true, max: 120 },
  { name: "position", type: "number" },
];

const cardFields: NormalizedField[] = [
  { name: "title", type: "string", required: true, max: 200 },
  { name: "list", type: "ref", entity: "lists" },
  { name: "priority", type: "enum", values: ["none", "low", "medium", "high", "urgent"] },
  { name: "due", type: "string", max: 10, dayKey: true },
  { name: "done", type: "boolean" },
  { name: "created", type: "datetime", readOnly: true },
];

export const FULL_TOKEN = "a2app_conformance_full";
export const READONLY_TOKEN = "a2app_conformance_readonly";

const grants: Grant[] = [
  { token: FULL_TOKEN, credentialId: "cred_full", agentName: "conformance", principal: "owner", scopes: ["*"] },
  {
    token: READONLY_TOKEN,
    credentialId: "cred_ro",
    agentName: "reporter",
    principal: "owner",
    scopes: ["data:cards:read", "data:lists:read"],
  },
];

export interface ReferenceApp {
  app: A2App;
  server: Server;
  url: string;
  port: number;
  fullToken: string;
  readonlyToken: string;
  close(): Promise<void>;
}

export function buildReferenceApp(): A2App {
  const binding = new MemoryBinding({
    appId: "conformance_kanban",
    appName: "Conformance Kanban",
    adapterVersion: "0.1.0",
    entities: {
      lists: {
        fields: listFields,
        module: "board",
        summary: "columns the cards move through",
        seed: [
          { id: "list_todo", title: "To Do", position: 1 },
          { id: "list_doing", title: "Doing", position: 2 },
        ],
      },
      cards: {
        fields: cardFields,
        module: "board",
        summary: "the work itself",
        seed: [{ id: "card_seed", title: "Welcome card", list: "list_todo", priority: "low", created: "2026-07-30T00:00:00.000Z" }],
      },
    },
    operations: {
      "archive-board": () => ({ archived: true, at: "2026-07-31T09:15:00.000Z" }),
      "count-cards": () => ({ count: 1 }),
      "finish-card": () => ({ ok: true }),
    },
  });

  return createA2App(binding, {
    credentials: grants,
    modules: [{ name: "board", summary: "lists and the cards on them" }],
    operations: [
      { name: "archive-board", description: "Archive every card on the board.", destructive: true, module: "board", params: {} },
      {
        name: "count-cards",
        description: "Count the cards.",
        destructive: false,
        readOnly: true,
        idempotent: true,
        module: "board",
        params: {},
      },
      // Attached to an entity and gated on that record's state, so the record
      // level has both an available and a blocked operation to report.
      {
        name: "finish-card",
        description: "Mark one card done.",
        destructive: false,
        module: "board",
        entity: "cards",
        appliesWhen: { field: "done", ne: true },
        params: { card: { type: "ref", entity: "cards", required: true } },
      },
    ],
    events: [{ type: "card.due_soon" }],
    credentialHint: "Read the app's .agent-token file (mode 0600).",
  });
}

/** Boot the reference app on an ephemeral port. */
export async function startReferenceApp(): Promise<ReferenceApp> {
  const app = buildReferenceApp();
  const server = createA2AppServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    app,
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    fullToken: FULL_TOKEN,
    readonlyToken: READONLY_TOKEN,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
