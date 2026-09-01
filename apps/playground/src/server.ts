/**
 * The playground Agent App — a small contacts app, workspace-linked to
 * `@a2app/adapter-core`, so it boots for real. It is a live example of the
 * embedded-middleware adapter form and the target of an end-to-end boot test
 * that launches it and drives the live protocol over HTTP.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createA2App, createA2AppServer, MemoryBinding, type A2App, type Grant } from "@a2app/adapter-core";
import type { NormalizedField } from "@a2app/rules";

const contactFields: NormalizedField[] = [
  { name: "name", type: "string", required: true, max: 120 },
  { name: "email", type: "string", max: 200 },
  { name: "company", type: "string", max: 120 },
  { name: "tier", type: "enum", values: ["lead", "customer", "vip"] },
  { name: "follow_up", type: "string", max: 10, dayKey: true },
  { name: "created", type: "datetime", readOnly: true },
];

export const PLAYGROUND_TOKEN = "a2app_playground_token";

export function buildPlayground(): A2App {
  const binding = new MemoryBinding({
    appId: "playground_contacts",
    appName: "Playground Contacts",
    entities: {
      contacts: {
        fields: contactFields,
        seed: [
          { id: "c_ada", name: "Ada Lovelace", email: "ada@example.com", tier: "vip", created: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
    operations: {
      "count-by-tier": (args) => {
        const tier = String((args as { tier?: unknown }).tier ?? "customer");
        return { tier, note: `counts computed for ${tier}` };
      },
    },
  });
  const grant: Grant = { token: PLAYGROUND_TOKEN, credentialId: "cred_local", agentName: "playground", principal: "owner", scopes: ["*"] };
  return createA2App(binding, {
    credentials: [grant],
    operations: [{ name: "count-by-tier", description: "Count contacts in a tier.", destructive: false, readOnly: true, idempotent: true }],
    events: [{ type: "contact.follow_up_due" }],
  });
}

export interface RunningPlayground {
  app: A2App;
  server: Server;
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export async function startPlayground(port = 0): Promise<RunningPlayground> {
  const app = buildPlayground();
  const server = createA2AppServer(app);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    app,
    server,
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    token: PLAYGROUND_TOKEN,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Run directly: `node dist/server.js` (defaults to PORT or 8092).
if (import.meta.url === `file://${process.argv[1]}`) {
  void startPlayground(Number(process.env.PORT ?? 8092)).then((p) =>
    process.stdout.write(`playground on ${p.url}  (A2App id playground_contacts)\n`),
  );
}
