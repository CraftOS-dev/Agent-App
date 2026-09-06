/**
 * The playground Agent App — a small contacts CRM, workspace-linked to
 * `@a2app/adapter-core`, so it boots for real. It is a live example of the
 * embedded-middleware adapter form.
 *
 * It is deliberately two modules and three entities rather than one entity. A
 * single-entity app cannot demonstrate the thing the protocol is now built
 * around: describe answers ONE level at a time (A2APP-SPEC 3), and an agent
 * arrives at a root screen and walks down to the record it needs. With one
 * entity every level collapses into the same screen, so a walk is
 * indistinguishable from a flat dump and the example teaches nothing.
 *
 * Each level of the walk has something here to show:
 *   root      two modules, so the first screen is a real choice
 *   module    entities and the module-level operations beside them
 *   entity    typed fields, and the operations that act on this entity
 *   record    per-record availability — `promote-to-customer` is blocked on a
 *             contact that is already a customer, and says so
 *   relation  `people.touchpoints` is a list<ref>, so a record has a
 *             sub-resource to open
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createA2App, createA2AppServer, MemoryBinding, type A2App, type Grant } from "@a2app/adapter-core";
import type { NormalizedField } from "@a2app/rules";

const companyFields: NormalizedField[] = [
  { name: "name", type: "string", required: true, max: 120 },
  { name: "domain", type: "string", max: 200 },
  { name: "created", type: "datetime", readOnly: true },
];

const personFields: NormalizedField[] = [
  { name: "name", type: "string", required: true, max: 120 },
  { name: "email", type: "string", max: 200 },
  { name: "company", type: "ref", entity: "companies" },
  { name: "tier", type: "enum", values: ["lead", "customer", "vip"] },
  { name: "follow_up", type: "string", max: 10, dayKey: true },
  { name: "archived", type: "boolean" },
  { name: "touchpoints", type: "list<ref>", entity: "touchpoints" },
  { name: "created", type: "datetime", readOnly: true },
];

const touchpointFields: NormalizedField[] = [
  { name: "person", type: "ref", entity: "people", required: true },
  { name: "channel", type: "enum", values: ["email", "call", "meeting"] },
  { name: "note", type: "string", max: 500 },
  { name: "replied", type: "boolean" },
  { name: "created", type: "datetime", readOnly: true },
];

export const PLAYGROUND_TOKEN = "a2app_playground_token";

export function buildPlayground(): A2App {
  const binding = new MemoryBinding({
    appId: "playground_contacts",
    appName: "Playground Contacts",
    entities: {
      companies: {
        fields: companyFields,
        module: "directory",
        summary: "organisations people belong to",
        seed: [{ id: "co_analytical", name: "Analytical Engines", domain: "analytical.example", created: "2026-01-01T00:00:00.000Z" }],
      },
      people: {
        fields: personFields,
        module: "directory",
        summary: "the contacts themselves",
        // Seeded so that each state-gated operation is BLOCKED on at least one
        // record and AVAILABLE on another. A seed where everything is available
        // would render the same screen as an app with no predicates at all, and
        // the reason text — the part a model must never compose — would never
        // appear.
        seed: [
          {
            // promote-to-customer blocked (already a customer); archive available
            id: "c_ada",
            name: "Ada Lovelace",
            email: "ada@example.com",
            company: "co_analytical",
            tier: "customer",
            touchpoints: ["tp_intro", "tp_followup"],
            created: "2026-01-01T00:00:00.000Z",
          },
          {
            // both available; explicit empty list so the relation count is a
            // truthful 0 rather than absent (which describe reports as unknown)
            id: "c_charles",
            name: "Charles Babbage",
            email: "charles@example.com",
            company: "co_analytical",
            tier: "lead",
            touchpoints: [],
            created: "2026-01-02T00:00:00.000Z",
          },
          {
            // archive-person blocked (already archived); promote available
            id: "c_grace",
            name: "Grace Hopper",
            email: "grace@example.com",
            tier: "vip",
            archived: true,
            touchpoints: [],
            created: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
      touchpoints: {
        fields: touchpointFields,
        module: "outreach",
        summary: "logged contact with a person",
        seed: [
          // mark-replied available on the first, blocked on the second
          { id: "tp_intro", person: "c_ada", channel: "email", note: "Sent the intro note.", created: "2026-01-03T00:00:00.000Z" },
          { id: "tp_followup", person: "c_ada", channel: "call", note: "Follow-up call; she replied.", replied: true, created: "2026-01-04T00:00:00.000Z" },
        ],
      },
    },
    operations: {
      "count-by-tier": (args) => {
        const tier = String((args as { tier?: unknown }).tier ?? "customer");
        return { tier, note: `counts computed for ${tier}` };
      },
      "promote-to-customer": (args) => ({ person: String((args as { person?: unknown }).person ?? ""), tier: "customer" }),
      "archive-person": (args) => ({ person: String((args as { person?: unknown }).person ?? ""), archived: true }),
      "mark-replied": (args) => ({ touchpoint: String((args as { touchpoint?: unknown }).touchpoint ?? ""), replied: true }),
    },
  });

  const grant: Grant = {
    token: PLAYGROUND_TOKEN,
    credentialId: "cred_local",
    agentName: "playground",
    principal: "owner",
    scopes: ["*"],
  };

  return createA2App(binding, {
    credentials: [grant],
    modules: [
      { name: "directory", summary: "people and the companies they belong to" },
      { name: "outreach", summary: "every logged contact with a person" },
    ],
    operations: [
      // Module-level: no `entity`, so it appears on the directory screen and on
      // no record.
      {
        name: "count-by-tier",
        description: "Count contacts in a tier.",
        destructive: false,
        readOnly: true,
        idempotent: true,
        module: "directory",
        params: { tier: { type: "enum", values: ["lead", "customer", "vip"], required: true } },
      },
      // Entity-level and state-gated: the record screen reports this available
      // on Charles (a lead) and blocked on Ada (already a vip), with the reason
      // derived from the predicate — never composed by a model.
      {
        name: "promote-to-customer",
        description: "Move a contact to the customer tier.",
        destructive: false,
        module: "directory",
        entity: "people",
        appliesWhen: { field: "tier", ne: "customer" },
        params: { person: { type: "ref", entity: "people", required: true } },
      },
      {
        name: "archive-person",
        description: "Archive a contact and stop outreach.",
        destructive: true,
        module: "directory",
        entity: "people",
        appliesWhen: { field: "archived", ne: true },
        params: { person: { type: "ref", entity: "people", required: true } },
      },
      {
        name: "mark-replied",
        description: "Record that a touchpoint got a reply.",
        destructive: false,
        module: "outreach",
        entity: "touchpoints",
        appliesWhen: { field: "replied", ne: true },
        params: { touchpoint: { type: "ref", entity: "touchpoints", required: true } },
      },
    ],
    events: [{ type: "contact.follow_up_due" }],
    credentialHint: "Read the app's .agent-token file (mode 0600).",
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
//
// Compared via pathToFileURL, not by pasting argv[1] after "file://". On Windows
// argv[1] is `C:\dir\server.js` while import.meta.url is `file:///C:/dir/server.js`,
// so the naive form never matches and `node dist/server.js` exits 0 having started
// nothing — a silent no-op that looks like a clean run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void startPlayground(Number(process.env.PORT ?? 8092)).then((p) =>
    process.stdout.write(`playground on ${p.url}  (A2App id playground_contacts)\n`),
  );
}
