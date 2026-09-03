/**
 * a2app <app> data schema
 * a2app <app> data <entity> [list|get <id>|create|update <id>|delete <id>]
 *                  [--field value ...] [--json '{...}'] [--filter '...'] [--sort '...']
 *                  [--limit N] [--idempotency-key KEY]
 *
 * The A2App data client. Reads and writes records through the public
 * describe/records surface — anything this CLI does, any agent can. Values are
 * coerced client-side (dates, labels); the app validates.
 */
import { fetchSchema, coerceBody, renderSchema, suggest, droppedFields, nonReadableFields } from "@a2app/sdk";
import { BODY_CONTROL_FLAGS, buildBody, flag, positionals } from "../lib/args.js";
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { log } from "../lib/log.js";

export async function run(args: string[], app: string): Promise<number> {
  const [collection, verb = "list", id] = positionals(args);
  if (collection === undefined) {
    throw new UsageError(
      "Usage: a2app <app> data schema | <entity> [list|get <id>|create|update <id>|delete <id>] [--field value ...]",
    );
  }
  const project = loadProject(app);
  const client = await clientFor(project);
  const schema = await fetchSchema(client);

  if (collection === "schema") {
    log.raw(`${project.manifest.name} — entities (field(type), * = required):\n${renderSchema(schema)}`);
    return 0;
  }

  if (schema.size > 0 && !schema.has(collection)) {
    const hint = suggest(collection, [...schema.keys()]);
    log.error(`No entity "${collection}"${hint !== null ? ` — did you mean "${hint}"?` : ""}`);
    log.raw(`Entities:\n${renderSchema(schema)}`);
    return 1;
  }

  const idempotencyKey = flag(args, "idempotency-key");
  // A record body reserves only --json / --idempotency-key; every other flag is a
  // field, so common field names like `status` are settable from the CLI.
  let body = buildBody(args, BODY_CONTROL_FLAGS);

  if (body !== undefined && (verb === "create" || verb === "update")) {
    const coerced = await coerceBody(client, schema, collection, body);
    if (coerced.errors.length > 0) {
      for (const message of coerced.errors) log.error(message);
      return 1;
    }
    body = coerced.body;
  }

  let res;
  switch (verb) {
    case "list": {
      const query: { filter?: string; sort?: string; perPage?: number } = {};
      const filter = flag(args, "filter");
      const sort = flag(args, "sort");
      const limit = flag(args, "limit");
      if (filter !== undefined) query.filter = filter;
      if (sort !== undefined) query.sort = sort;
      if (limit !== undefined) query.perPage = Number(limit);
      res = await client.listRecords(collection, query);
      break;
    }
    case "get":
      if (id === undefined) throw new UsageError("get needs an id");
      res = await client.getRecord(collection, id);
      break;
    case "create":
      if (body === undefined) throw new UsageError('create needs fields (e.g. --title "…") or --json \'{...}\'');
      res = await client.createRecord(collection, body, idempotencyKey);
      break;
    case "update":
      if (id === undefined) throw new UsageError("update needs an <id>");
      if (body === undefined) throw new UsageError('update needs fields or --json \'{...}\'');
      res = await client.updateRecord(collection, id, body, idempotencyKey);
      break;
    case "delete":
      if (id === undefined) throw new UsageError("delete needs an id");
      res = await client.deleteRecord(collection, id);
      break;
    default:
      throw new UsageError(`unknown verb "${verb}"`);
  }

  if (res.status >= 300) {
    const parsed = res.json as Record<string, unknown> | null;
    log.error(String(parsed?.["message"] ?? `HTTP ${res.status}`));
    const violations = parsed?.["violations"];
    if (Array.isArray(violations) && violations.length > 1) {
      for (const v of violations.slice(1) as { field?: string; expected?: string }[]) {
        log.raw(`  also: --${v.field} expects ${v.expected}`);
      }
    }
    return 1;
  }

  log.raw(res.body || `(HTTP ${res.status}, ok)`);

  // Read-back backstop for adapters predating the in-app guard.
  if (body !== undefined && (verb === "create" || verb === "update")) {
    const saved = res.json as Record<string, unknown> | null;
    if (saved !== null) {
      // Exempt write-only / non-readable fields: the backend legitimately never
      // echoes them, so they must not be flagged "not stored" (e.g. passwords).
      const exempt = nonReadableFields(schema.get(collection), body);
      const dropped = droppedFields(body, saved, exempt);
      if (dropped.length > 0) {
        log.error(
          `WRITE INCOMPLETE — the app accepted the request but did not store: ${dropped.join(", ")}. Do NOT report this as done.`,
        );
        return 1;
      }
    }
  }
  return 0;
}
