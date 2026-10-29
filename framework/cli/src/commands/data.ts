/**
 * a2app <app> data schema
 * a2app <app> data <entity> schema
 * a2app <app> data <entity> [list|get <id>|create|update <id>|delete <id>]
 *                  [--field value ... | field=value ...] [--json '{...}'] [--filter '...']
 *                  [--sort '...'] [--limit N] [--idempotency-key KEY]
 *
 * Raw record access, alongside the walk. The walk is for browsing and acting;
 * `data` is for filtered queries and direct writes — the two cases a screen is
 * the wrong shape for.
 *
 * `data` is a reserved first path segment precisely so this can coexist with a
 * module namespace (framework spec 5.1). Values are coerced client-side (dates,
 * labels); the app's guard remains the authority.
 */
import {
  coerceBody,
  droppedFields,
  fetchEntityIndex,
  fetchEntitySchema,
  nonReadableFields,
  renderEntity,
  renderEntityIndex,
  suggest,
} from "@a2app/sdk";
import { BODY_CONTROL_FLAGS, buildBody, coerceScalar, flag, positionals } from "../lib/args.js";
import { UsageError } from "../lib/project.js";
import { connect, labelFor } from "../lib/target.js";
import { log } from "../lib/log.js";
import { callerRefused, reportRefusal } from "../lib/refusal.js";

/**
 * `field=value` words, the other way a body is written (`answer="Tokyo"` sets
 * what `--answer "Tokyo"` sets). Anything else in that place is a mistake to
 * name, not to drop.
 */
function assignedFields(words: string[], example: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0) throw new UsageError(`"${word}" is not a field: write --${example} "…" or ${example}="…"`);
    out[word.slice(0, at)] = coerceScalar(word.slice(at + 1));
  }
  return out;
}

export async function run(args: string[], app: string): Promise<number> {
  const [collection, verb = "list", id] = positionals(args);
  if (collection === undefined) {
    throw new UsageError(
      "Usage: a2app <app> data schema | <entity> [schema|list|get <id>|create|update <id>|delete <id>] [--field value ... | field=value ...]",
    );
  }
  const { client, target, caller } = await connect(app);

  // `data schema` is entity NAMES, grouped by module — never the whole model.
  // Field detail is one level in, which is what keeps this bounded at any app
  // size and is the whole point of the navigational surface.
  if (collection === "schema") {
    const index = await fetchEntityIndex(client);
    if (index.size === 0) {
      log.error("No readable entities — is the app running, and does your credential hold any data scope?");
      return 1;
    }
    log.raw(`${labelFor(target)} — entities by module:\n${renderEntityIndex(index)}`);
    log.raw(`\n  → a2app ${app} data <entity> schema     (that entity's fields)`);
    return 0;
  }

  const schema = await fetchEntitySchema(client, collection);
  if (schema === null) {
    // A refused credential reads as "no such entity" from describe; say the
    // real reason instead.
    const refused = await callerRefused(client);
    if (refused !== null) {
      reportRefusal(refused, "the app", caller);
      return 1;
    }
    const index = await fetchEntityIndex(client);
    const hint = suggest(collection, [...index.keys()]);
    log.error(`No entity "${collection}"${hint !== null ? ` — did you mean "${hint}"?` : ""}`);
    if (index.size > 0) log.raw(`Entities:\n${renderEntityIndex(index)}`);
    return 1;
  }

  if (verb === "schema") {
    log.raw(renderEntity(schema));
    log.raw(`\n  → a2app ${app} ${schema.module} ${collection}     (fields and operations, as a screen)`);
    return 0;
  }

  const idempotencyKey = flag(args, "idempotency-key");
  // A field of this entity, for the usage messages: an example the agent can use.
  const example = schema.fields.find((f) => !f.readOnly)?.name ?? "field";
  // A record body reserves only --json / --idempotency-key; every other flag is a
  // field, so common field names like `status` are settable from the CLI.
  let body = buildBody(args, BODY_CONTROL_FLAGS);
  if (verb === "create" || verb === "update") {
    const assigned = assignedFields(positionals(args).slice(verb === "update" ? 3 : 2), example);
    if (Object.keys(assigned).length > 0) body = { ...assigned, ...body };
  }

  if (body !== undefined && (verb === "create" || verb === "update")) {
    const coerced = await coerceBody(client, new Map([[collection, schema]]), collection, body);
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
      if (body === undefined) throw new UsageError(`create needs fields: --${example} "…" (or ${example}="…"), or --json '{...}'`);
      res = await client.createRecord(collection, body, idempotencyKey);
      break;
    case "update":
      if (id === undefined) throw new UsageError("update needs an <id>");
      if (body === undefined) throw new UsageError(`update <id> needs fields: --${example} "…" (or ${example}="…"), or --json '{...}'`);
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
    reportRefusal(res, `${verb} ${collection}`, caller);
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
      // This is sound only because the entity level publishes EVERY readable
      // field — a summarised model would exempt real fields and mute the check.
      const exempt = nonReadableFields(schema, body);
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
