/**
 * A lifetime as written on the command line: a whole number and a unit —
 * `90s`, `45m`, `12h`, `30d`. Returns seconds.
 */
import { UsageError } from "./project.js";

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDuration(value: string, flagName: string): number {
  const unit = value.slice(-1).toLowerCase();
  const amount = Number(value.slice(0, -1));
  const seconds = UNIT_SECONDS[unit];
  if (seconds === undefined || value.length < 2 || !Number.isInteger(amount) || amount <= 0) {
    throw new UsageError(`--${flagName} is a whole number and a unit: 90s, 45m, 12h or 30d (got "${value}")`);
  }
  return amount * seconds;
}
