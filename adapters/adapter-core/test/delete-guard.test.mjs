/**
 * Deleting a record that other records still point at.
 *
 * An app that guards deletion inside an operation has guarded one way in: its
 * own UI. The generic record route — `DELETE /api/collections/{entity}/records/{id}`,
 * reached by `a2app <app> data <entity> delete <id>` — is the other, and it used
 * to go straight to the store. So the rule held right up until an agent took the
 * path the rule did not cover, and the orphan it left behind was reported as a
 * successful delete.
 *
 * The check cannot live in the app: record deletion is adapter code, which
 * toolkit-sync overwrites. So the app declares the relationship it already has
 * to declare — a `ref` names the entity it targets — and the adapter enforces it
 * on the one path both doors pass through.
 *
 * Standard library only, run directly.
 */
import { createA2App, MemoryBinding } from "../dist/index.js";

const failures = [];
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) failures.push(`${label}\n    expected: ${w}\n    actual:   ${g}`);
};
const ok = (label, cond) => {
  if (!cond) failures.push(label);
};

/** An invoicing app: invoices point at a client, and may cite several projects. */
const build = (onDelete) =>
  createA2App(
    new MemoryBinding({
      appId: "billing",
      appName: "Billing",
      entities: {
        clients: {
          module: "sales",
          fields: [{ name: "name", type: "string", required: true }],
          seed: [
            { id: "c_acme", name: "Acme" },
            { id: "c_unused", name: "Nobody" },
          ],
        },
        projects: {
          module: "sales",
          fields: [{ name: "title", type: "string", required: true }],
          seed: [{ id: "p_one", title: "One" }],
        },
        invoices: {
          module: "sales",
          fields: [
            { name: "total", type: "number" },
            // The relationship the app already declares. Nothing extra is asked
            // of the author for the default to apply.
            { name: "client", type: "ref", entity: "clients", ...(onDelete ? { onDelete } : {}) },
            { name: "projects", type: "list<ref>", entity: "projects" },
          ],
          seed: [{ id: "inv_1", total: 100, client: "c_acme", projects: ["p_one"] }],
        },
      },
    }),
    {
      modules: [{ name: "sales", summary: "clients and what they owe" }],
      credentials: [
        { token: "t", credentialId: "cred", agentName: "test", principal: "owner", scopes: ["*"] },
      ],
    },
  );

const call = (app, method, path, body) =>
  app.handle({ method, path, headers: { "x-a2app-token": "t" }, query: {}, body });

const del = (app, entity, id) => call(app, "DELETE", `/api/collections/${entity}/records/${id}`);

/* ------------------------------------------- the reported hole, closed */

{
  const app = build();
  const res = await del(app, "clients", "c_acme");
  check("a referenced client is not deleted", res.status, 409);
  check("and says why, by code", res.json.code, "record_referenced");
  ok("the message names the record", /c_acme/.test(res.json.message));
  ok("and where the references are", /invoices\.client/.test(res.json.message));

  // A caller that is refused needs to know WHICH records are in the way; "no"
  // with no location is a wall, not an answer.
  // Read through a blank rather than indexing directly: when this regresses the
  // delete simply succeeds, and a test that throws on the first missing field
  // reports one TypeError instead of the list of things that are now wrong.
  const by = Array.isArray(res.json.referencedBy) ? res.json.referencedBy : [];
  const first = by[0] ?? {};
  ok("the blocking records are reported", by.length === 1);
  check("naming the entity", first.entity, "invoices");
  check("and the field", first.field, "client");
  check("and the record ids", first.ids, ["inv_1"]);
  ok("with a stated way forward", typeof res.json.resolution === "string" && res.json.resolution.length > 0);

  // The point of the guard: nothing was half-done.
  const client = await call(app, "GET", "/api/collections/clients/records/c_acme");
  check("the client is still there", client.status, 200);
  const invoice = await call(app, "GET", "/api/collections/invoices/records/inv_1");
  check("the invoice is untouched", invoice.status, 200);
  check("still pointing at its client", invoice.json.client, "c_acme");
}

/* --------------------------------------------- what must still work */

{
  const app = build();
  const res = await del(app, "clients", "c_unused");
  check("a client nobody references still deletes", res.status, 200);
  check("and reports what it deleted", res.json.deleted, "c_unused");
}

{
  // Removing the reference removes the block — the guard is about the current
  // state, not a permanent mark on the record.
  const app = build();
  const first = await del(app, "clients", "c_acme");
  check("blocked while the invoice exists", first.status, 409);
  const dropped = await del(app, "invoices", "inv_1");
  check("the invoice itself deletes", dropped.status, 200);
  const second = await del(app, "clients", "c_acme");
  check("and now the client does too", second.status, 200);
}

/* ------------------------------------------------ list<ref> counts too */

{
  // A reference held in a list is still a reference. Checking only scalar refs
  // would leave exactly the same hole, one type over.
  const app = build();
  const res = await del(app, "projects", "p_one");
  check("a project cited in a list<ref> is not deleted", res.status, 409);
  check("with the same code", res.json.code, "record_referenced");
  const cited = (Array.isArray(res.json.referencedBy) ? res.json.referencedBy : [])[0] ?? {};
  check("naming the list field", cited.field, "projects");
  check("and the record holding it", cited.ids, ["inv_1"]);
}

/* --------------------------------------------- the deliberate opt-out */

{
  // An app that means for references to outlive the record says so, and then it
  // is a decision recorded in the schema rather than an accident.
  const app = build("ignore");
  const res = await del(app, "clients", "c_acme");
  check('onDelete "ignore" allows the delete', res.status, 200);
  const invoice = await call(app, "GET", "/api/collections/invoices/records/inv_1");
  check("the invoice survives", invoice.status, 200);
  check("with its reference left as declared", invoice.json.client, "c_acme");

  // The opt-out is per field: the list<ref> never asked for it.
  const stillGuarded = await del(app, "projects", "p_one");
  check("the other ref is still guarded", stillGuarded.status, 409);
}

/* ------------------------------------------------------ absent record */

{
  const app = build();
  const res = await del(app, "clients", "c_missing");
  check("a record that does not exist is still 404, not 409", res.status, 404);
  check("with its own code", res.json.code, "record_not_found");
}

/* ---------------------------------------------------------------- report */

if (failures.length > 0) {
  console.error(`delete-guard: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log("delete-guard: all checks passed");
