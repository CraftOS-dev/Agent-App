/** Tiny flag parser shared by the operate commands. */

/** Control flags that steer the query/body and are never record fields. */
export const CONTROL_FLAGS = new Set([
  "json",
  "filter",
  "sort",
  "limit",
  "idempotency-key",
  "approve",
  "status",
  "since",
  "blueprint",
  "name",
]);

/**
 * Control flags for a RECORD BODY (create/update). Deliberately minimal: only
 * the flags `data` itself consumes. Everything else — including `status`,
 * `filter`, `sort`, `limit`, `since` — is a legitimate entity field name (a
 * `status` field is one of the most common of all), so a record body must NOT
 * treat them as reserved, or those fields become unsettable from the CLI.
 */
export const BODY_CONTROL_FLAGS = new Set(["json", "idempotency-key"]);

/** Value of `--name`, or undefined. */
export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** Positionals: tokens that are neither a `--flag` nor a flag's value. */
export function positionals(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
}

/** Coerce a CLI string into the JSON scalar it most likely represents. */
export function coerceScalar(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Collect `--field value` pairs (excluding CONTROL_FLAGS) into a body object.
 *  A valueless flag is an error, never coerced to `true`. */
export function collectFields(args: string[], control: Set<string> = CONTROL_FLAGS): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined || !token.startsWith("--")) continue;
    const key = token.slice(2);
    if (control.has(key)) {
      i++; // skip its value
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new ValuelessFlagError(`--${key} has no value. Every flag needs one: --${key} "value".`);
    }
    out[key] = coerceScalar(next);
    i++;
  }
  return out;
}

/**
 * Build a write body from --json (base) merged with --field flags (override).
 * `control` names the flags to treat as controls rather than fields; for a
 * record body pass {@link BODY_CONTROL_FLAGS} so common field names like
 * `status` are not swallowed. Bad JSON in --json is a usage error (exit 2).
 */
export function buildBody(
  args: string[],
  control: Set<string> = CONTROL_FLAGS,
): Record<string, unknown> | undefined {
  const jsonBody = flag(args, "json");
  const fields = collectFields(args, control);
  if (jsonBody !== undefined) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonBody) as Record<string, unknown>;
    } catch (err) {
      throw new ValuelessFlagError(`--json is not valid JSON: ${(err as Error).message}`);
    }
    return { ...parsed, ...fields };
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** A valueless flag is a usage error (exit 2). */
export class ValuelessFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValuelessFlagError";
  }
}
