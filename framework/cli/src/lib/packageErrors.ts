/**
 * How fetching, inspecting and installing a package fails, sorted by what the
 * caller should do about it (the CLI exit-code contract, framework packaging §8):
 *
 *   PackageRefusedError     the package or source is not acceptable as it is  → 1
 *   SourceNotFoundError     the source answered, and what was asked for is
 *                           not there (a 404, an unknown catalogue id)        → 1
 *   SourceUnreachableError  the source could not be reached at all, or did
 *                           not answer in time                                → 3
 *
 * Kept apart from UsageError (a mistyped command, exit 2) because a refusal is a
 * property of the package, not of how the command was written: retrying the same
 * line will refuse again, while an unreachable source may well answer next time.
 */
import { ValuelessFlagError } from "./args.js";
import { UsageError } from "./project.js";

export class PackageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageRefusedError";
  }
}

export class SourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceNotFoundError";
  }
}

export class SourceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceUnreachableError";
  }
}

/** The exit code an error maps to under the CLI contract. */
export function exitCodeOf(err: unknown): number {
  if (err instanceof UsageError || err instanceof ValuelessFlagError) return 2;
  if (err instanceof SourceUnreachableError) return 3;
  return 1;
}

/** A byte count as people read it: `512 MiB`, `1.5 KiB`. */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}
