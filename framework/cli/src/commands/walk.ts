/**
 * The walk: `a2app <app> [<path…>] [<operation>] [--params]`.
 *
 * This is the operate client's primary surface (A2APP-SPEC 4.1). Its shape IS
 * describe's hierarchy — one command per screen, arguments naming a location
 * rather than a verb:
 *
 *   a2app ./atlas                                     root
 *   a2app ./atlas sales                               module
 *   a2app ./atlas sales invoices                      entity
 *   a2app ./atlas sales invoices INV-8841             record
 *   a2app ./atlas sales invoices INV-8841 lines       sub-resource
 *   a2app ./atlas sales invoices INV-8841 issue-credit-note --lines ln_2
 *   a2app ./atlas --find credit                       search
 *
 * An operation is invoked in place, at the end of the path that identifies it,
 * because that path is what establishes which operation is meant. There is no
 * global operation namespace here and therefore no global list to carry.
 *
 * Every screen ends by naming the legal next moves. That is not decoration: it
 * is the only navigation aid the surface has, and it is what lets an agent
 * operate an app it has never seen without a help system.
 */
import type { DescribeLevel, DescribeModule, DescribeRecord, DescribeRoot } from "@a2app/sdk";
import { collectFields, flag, positionals } from "../lib/args.js";
import { clientFor, loadProject, UsageError } from "../lib/project.js";
import { DescribeCache } from "../lib/describeCache.js";
import { log } from "../lib/log.js";

/** Flags the walk itself consumes; everything else is an operation parameter. */
const WALK_FLAGS = new Set(["find", "all", "approve", "idempotency-key"]);

export async function run(args: string[], app: string): Promise<number> {
  const project = loadProject(app);
  const client = await clientFor(project);

  const term = flag(args, "find");
  if (term !== undefined) return renderLevel(await fetchFind(client, term), app);

  const segments = positionals(args);
  const wantAll = args.includes("--all");

  // Discovery is cached against the app's own schemaVersion, so a repeated walk
  // costs one identity probe rather than a fresh descent. Without this the
  // ≤2 round-trip write budget would be spent navigating.
  const identity = await client.identity();
  const cache =
    identity === null ? null : DescribeCache.open(project.dir, identity.app.id, identity.schemaVersion);

  // Walk down as far as the path goes, one level per segment. Each level is
  // fetched (or read from cache) before the next, because only the level knows
  // what its own children are called — that is what makes the surface
  // self-describing rather than guessable.
  let path = "";
  let level = await fetchLevel(client, cache, "", false);
  if (level === null) return unreachable(app);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    // At a record, a remaining segment is either a sub-resource or an operation
    // to invoke. The record level itself tells us which — no guessing.
    if (level.level === "record") {
      const operation = level.operations.find((o) => o.name === segment);
      if (operation) return invokeOperation(client, level, operation.name, args, app);
      const relation = (level.relations ?? []).find((r) => r.name === segment);
      if (!relation) {
        return notHere(segment, level, app, path);
      }
    }

    // At a module, a remaining segment may be a module-level operation.
    if (level.level === "module") {
      const operation = level.operations.find((o) => o.name === segment);
      if (operation) return invokeOperation(client, null, operation.name, args, app);
    }

    const isLast = i === segments.length - 1;
    const next = await fetchLevel(client, cache, `${path}${path ? "/" : ""}${segment}`, isLast && wantAll);
    if (next === null) return notHere(segment, level, app, path);
    path = `${path}${path ? "/" : ""}${segment}`;
    level = next;
  }

  cache?.flush();
  return renderLevel(level, app);
}

/* ------------------------------------------------------------------ fetch */

type Client = Awaited<ReturnType<typeof clientFor>>;

/**
 * Levels that may be cached against `schemaVersion`.
 *
 * ONLY these three. Root, module, and entity are derived from the app's model,
 * so `schemaVersion` is a complete cache key for them: when the model changes the
 * key changes, and until it does they cannot go stale.
 *
 * A record or relation level is derived from DATA. Its operations are marked
 * available or blocked from that record's current values, which change on every
 * write without touching `schemaVersion` — so caching one would show an agent a
 * record screen describing a state the record has left, and it would act on it.
 * That is the exact "never write against a stale schema" failure, one level down.
 */
const CACHEABLE_LEVELS = new Set(["root", "module", "entity"]);

/** One level, from cache when it is safe to cache, else from the app.
 *  `?all=true` is never cached either: it is the deliberate escape hatch from
 *  truncation and must reflect the app at the moment it is asked. */
async function fetchLevel(
  client: Client,
  cache: DescribeCache | null,
  path: string,
  all: boolean,
): Promise<DescribeLevel | null> {
  if (!all) {
    const hit = cache?.get(path);
    if (hit) return hit;
  }
  const level = await client.describe(path, all ? { all: true } : {});
  if (level !== null && !all && CACHEABLE_LEVELS.has(level.level)) cache?.put(path, level);
  return level;
}

async function fetchFind(client: Client, term: string): Promise<DescribeLevel | null> {
  if (term === "") throw new UsageError("--find needs a term: a2app <app> --find <term>");
  return client.find(term);
}

/* --------------------------------------------------------------- invoking */

/**
 * Invoke an operation at the path that identified it.
 *
 * When the path reached a record, that record is passed as the operation's
 * target so the caller does not repeat an id the path already carries. A
 * destructive operation still needs a human's approval key — the CLI never
 * self-approves, at any level.
 */
async function invokeOperation(
  client: Client,
  record: DescribeRecord | null,
  operation: string,
  args: string[],
  app: string,
): Promise<number> {
  const declared = record?.operations.find((o) => o.name === operation);
  if (record && declared && declared.available === false) {
    log.error(`"${operation}" is not available on ${record.label ?? record.id}: ${declared.blocked}`);
    return 1;
  }

  const params = collectFields(args, WALK_FLAGS);
  // The path already named the record, so fill in the parameter that takes it
  // rather than making the caller repeat the id. The record level names that
  // parameter; an explicit flag still wins, so a caller can always be exact.
  if (record && declared?.targetParam && params[declared.targetParam] === undefined) {
    params[declared.targetParam] = record.id;
  }
  const approvalKey = flag(args, "approve");
  const res = await client.callOperation(operation, params, approvalKey);

  if (res.status >= 300) {
    const parsed = res.json as Record<string, unknown> | null;
    log.error(String(parsed?.["message"] ?? `HTTP ${res.status}`));
    if (parsed?.["code"] === "approval_required" && typeof parsed["approvalKey"] === "string") {
      log.warn("This is a destructive operation. A human must approve it, then re-run:");
      // The retry line repeats every argument. An approval key is bound to the
      // exact call it was issued for, so a hint that dropped the parameters
      // would produce a key mismatch when copied verbatim.
      const echoed = args.filter((a) => a !== "--approve" && a !== approvalKey).join(" ");
      log.raw(`  a2app ${app} ${echoed} --approve ${parsed["approvalKey"]}`.replace(/\s+/g, " "));
    }
    return 1;
  }
  log.raw(res.body || `(HTTP ${res.status}, ok)`);
  return 0;
}

/* -------------------------------------------------------------- rendering */

/** Print a level, then the moves it says are legal from here. */
function renderLevel(level: DescribeLevel | null, app: string): number {
  if (level === null) return unreachable(app);
  switch (level.level) {
    case "root":
      log.raw(renderRoot(level));
      break;
    case "module":
      log.raw(renderModule(level));
      break;
    case "entity":
      log.raw(renderEntityLevel(level));
      break;
    case "record":
      log.raw(renderRecord(level));
      break;
    case "relation":
      log.raw(
        [`${level.path} — ${level.entity}`, ...level.items.map((i) => `  ${i.id}  ${i.label ?? ""}`.trimEnd())].join(
          "\n",
        ) + truncationNote(level.truncated),
      );
      break;
    case "find":
      log.raw(
        level.matches.length === 0
          ? `No entity, operation, or module matches "${level.term}".`
          : level.matches
              .map((m) => (m.operation ? `  ${m.path} → ${m.operation}` : `  ${m.path}`))
              .join("\n") + truncationNote(level.truncated),
      );
      break;
  }
  log.raw(nextLine(level, app));
  return 0;
}

function renderRoot(level: DescribeRoot): string {
  const width = Math.max(0, ...level.modules.map((m) => m.name.length));
  const rows = level.modules.map((m) => {
    const note = m.access === "full" ? "" : m.access === "read-only" ? "   read-only for you" : "   no access";
    const counts = `${m.entities} entit${m.entities === 1 ? "y" : "ies"}, ${m.operations} op${m.operations === 1 ? "" : "s"}`;
    return `  ${m.name.padEnd(width)}  ${(m.summary ?? "").padEnd(40)} ${counts}${note}`.trimEnd();
  });
  return [`${level.app.name ?? level.app.id} — ${level.modules.length} modules`, "", ...rows].join("\n");
}

function renderModule(level: DescribeModule): string {
  const lines = [`${level.path}${level.summary ? ` — ${level.summary}` : ""}`, ""];
  if (level.entities.length > 0) {
    const width = Math.max(...level.entities.map((e) => e.name.length));
    lines.push(...level.entities.map((e) => `  ${e.name.padEnd(width)}  ${e.summary ?? ""}`.trimEnd()));
  }
  if (level.operations.length > 0) {
    lines.push("", "  HERE");
    const width = Math.max(...level.operations.map((o) => o.name.length));
    for (const o of level.operations) {
      lines.push(`  ${o.name.padEnd(width)}  ${o.summary ?? ""}${o.destructive ? "   needs approval" : ""}`.trimEnd());
    }
  }
  return lines.join("\n") + truncationNote(level.truncated);
}

function renderEntityLevel(level: Extract<DescribeLevel, { level: "entity" }>): string {
  const entries = Object.entries(level.fields);
  const width = Math.max(0, ...entries.map(([n]) => n.length));
  const fields = entries.map(([name, f]) => {
    const type = f.entity !== undefined ? `->${f.entity}` : f.values ? f.values.join("|") : f.type;
    const marks = [f.required ? "required" : "", f.readOnly ? "read-only" : "", f.max ? `max ${f.max}` : ""]
      .filter(Boolean)
      .join(", ");
    return `  ${name.padEnd(width)}  ${type}${marks ? `   ${marks}` : ""}`;
  });
  const lines = [`${level.path} — ${entries.length} fields`, "", "  FIELDS", ...fields];
  if (level.operations.length > 0) {
    lines.push("", "  HERE");
    for (const o of level.operations) {
      const signature = Object.entries(o.params)
        .map(([n, p]) => (p.required ? `--${n} <${p.type}>` : `[--${n} <${p.type}>]`))
        .join(" ");
      lines.push(`  ${o.name} ${signature}`.trimEnd() + (o.destructive ? "   needs approval" : ""));
      if (o.description) lines.push(`      ${o.description}`);
    }
  }
  return lines.join("\n");
}

function renderRecord(level: DescribeRecord): string {
  const lines = [`${level.path}${level.label ? ` — ${level.label}` : ""}`, ""];
  if (level.operations.length > 0) {
    lines.push("  HERE");
    for (const o of level.operations) {
      lines.push(
        o.available
          ? `  ${o.name}${o.destructive ? "   needs approval" : ""}`
          : `  ${o.name}   blocked: ${o.blocked}`,
      );
    }
  }
  if (level.relations && level.relations.length > 0) {
    lines.push("", "  RELATIONS");
    for (const r of level.relations) {
      lines.push(`  ${r.name}  ${r.count ?? "?"} × ${r.entity}`);
    }
  }
  return lines.join("\n");
}

/** Entries dropped to fit the budget are always reported. A silent truncation
 *  reads as a complete answer, which is the one thing it must never do. */
function truncationNote(truncated: number | undefined): string {
  return truncated ? `\n\n  … ${truncated} more (add --all)` : "";
}

/**
 * The footer every screen ends with: the level's own `next`, rendered as
 * commands the caller can run verbatim.
 *
 * `next` is transport-neutral — it names describe paths, because the same field
 * serves HTTP callers. Here they become CLI positionals, so a slash-separated
 * path is split into arguments and the search form becomes its flag. Printing
 * the wire form unchanged would hand an agent a line that does not run, which is
 * worse than printing nothing: the footer is the one thing it is meant to trust.
 */
function nextLine(level: DescribeLevel, app: string): string {
  const moves = level.next.map((move) => {
    const search = /^describe\?find=(.*)$/.exec(move);
    if (search) return `a2app ${app} --find ${search[1]}`;
    const described = /^describe\/(.*)$/.exec(move);
    if (described) {
      // `?all=true` is the wire form of the un-truncate escape hatch; on the CLI
      // it is a flag. Printing the query string would offer a line that does not
      // run, on the exact screen where the caller most needs one that does.
      const [target, query] = described[1]!.split("?");
      const flag = query === "all=true" ? " --all" : "";
      return `a2app ${app} ${target!.split("/").join(" ")}${flag}`;
    }
    // An action move is `<path> <operation> [args]`; only the path is
    // slash-separated, and the rest is already command text.
    const [head, ...rest] = move.split(" ");
    const rendered = [head!.split("/").join(" "), ...rest].join(" ");
    return `a2app ${app} ${rendered}`.trimEnd();
  });
  return ["", "  → " + moves.join("\n  → ")].join("\n");
}

function unreachable(app: string): number {
  log.error(`No describe surface at ${app}. Is the app running and does it carry an adapter?`);
  return 1;
}

/** A segment that is not a child of where we stand. The level already knows its
 *  own children, so the correction is exact rather than a guess. */
function notHere(segment: string, level: DescribeLevel, app: string, path: string): number {
  const here = path === "" ? "the app root" : path;
  log.error(`"${segment}" is not here (${here}).`);
  log.raw(nextLine(level, app));
  return 1;
}
