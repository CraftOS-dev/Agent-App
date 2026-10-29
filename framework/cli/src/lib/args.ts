/** Tiny flag parser shared by the operate commands. */
import { UsageError } from "./project.js";

/** The flags a command takes. */
export interface FlagSpec {
  /** flags taking one value, given at most once */
  values?: string[];
  /** flags taking a value, given any number of times */
  lists?: string[];
  /** flags taking no value */
  booleans?: string[];
}

export interface ParsedFlags {
  values: Map<string, string>;
  lists: Map<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

/**
 * Parse a command's arguments against exactly the flags it takes.
 *
 * Strict where {@link flag} is lenient, for commands that change the machine:
 * an unknown flag, a value flag given twice or without a value, is a usage
 * error (exit 2) rather than something to ignore — a mistyped `--no-strat` on
 * an install must not quietly launch the app.
 */
export function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { values: new Map(), lists: new Map(), booleans: new Set(), positionals: [] };
  const values = new Set(spec.values ?? []);
  const lists = new Set(spec.lists ?? []);
  const booleans = new Set(spec.booleans ?? []);
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      out.positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (booleans.has(name)) {
      out.booleans.add(name);
      continue;
    }
    if (!values.has(name) && !lists.has(name)) throw new UsageError(`Unknown option: ${token}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ValuelessFlagError(`--${name} has no value. Every flag needs one: --${name} "value".`);
    }
    i += 1;
    if (lists.has(name)) {
      out.lists.set(name, [...(out.lists.get(name) ?? []), value]);
    } else {
      if (out.values.has(name)) throw new UsageError(`--${name} is given twice`);
      out.values.set(name, value);
    }
  }
  return out;
}

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

/**
 * Every value of a repeatable `--name value` flag, in the order given.
 *
 * {@link flag} returns the first occurrence, which is the right answer for a
 * flag that names one thing. A flag that names a SET (`--capability a
 * --capability b`) needs all of them, and silently honouring only the first
 * would narrow a filter the caller widened.
 */
export function flagAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== `--${name}`) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ValuelessFlagError(`--${name} has no value. Every flag needs one: --${name} "value".`);
    }
    out.push(value);
  }
  return out;
}

/**
 * The scopes `--scopes` names, or `["*"]` when it names none. Separated by
 * commas or spaces, and the flag may repeat: PowerShell turns an unquoted `a,b`
 * into the single argument "a b" before the CLI sees it.
 */
export function scopesFlag(args: string[]): string[] {
  const listed = flagAll(args, "scopes").flatMap((value) => value.split(/[\s,]+/)).filter((s) => s !== "");
  return listed.length > 0 ? listed : ["*"];
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
