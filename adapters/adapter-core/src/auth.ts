/**
 * The security primitives behind accounts, sessions, invites, device codes and
 * credentials (spec/v0_2/auth.md). Kept apart from the served surface so each
 * rule — what a secret looks like, how it is stored, how a password is checked —
 * is written once.
 *
 * Every secret the app hands out (tokens, session ids, invite codes, device
 * codes) is 256 random bits, returned once, and stored only as its SHA-256.
 * Passwords are PBKDF2-SHA256 at 600 000 iterations (OWASP), compared in
 * constant time.
 */
import { createHash, pbkdf2, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

/* -------------------------------------------------------------- secrets */

/** 256 random bits, base64url (43 chars). */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** An agent credential token: `a2a_` + 256 random bits. */
export function newToken(): string {
  return "a2a_" + newSecret();
}

/** How a secret is stored and looked up: hex SHA-256 of the whole string. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** An id that is not a secret: `prefix_` + 64 random bits, hex. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/* ------------------------------------------------------------ passwords */

export const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** `pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>` */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const key = await pbkdf2Async(password, salt, iterations, PBKDF2_KEY_BYTES, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Constant-time check of `password` against a stored hash. A malformed hash
 *  never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  const salt = Buffer.from(parts[2]!, "base64");
  const expected = Buffer.from(parts[3]!, "base64");
  const actual = await pbkdf2Async(password, salt, iterations, expected.length, "sha256");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ----------------------------------------------------------- user codes */

/** Consonants only (RFC 8628 §6.1): no vowels, so no words; no look-alikes. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** `XXXX-XXXX` from {@link USER_CODE_ALPHABET}. */
export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A user code as typed: case and the dash do not matter. */
export function normalizeUserCode(input: string): string {
  const letters = [...input.toUpperCase()].filter((c) => USER_CODE_ALPHABET.includes(c)).join("");
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : "";
}

/* -------------------------------------------------------------- cookies */

/** `Cookie` header → name/value pairs (the first occurrence of a name wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      /* not a value this app wrote */
    }
  }
  return out;
}

/** A `Set-Cookie` value for the session cookie. `maxAgeSeconds: 0` clears it. */
export function sessionCookie(name: string, value: string, opts: { maxAgeSeconds: number; secure: boolean }): string {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${opts.maxAgeSeconds}`];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/* ----------------------------------------------------- failure limiting */

/**
 * Counts failures per key in a fixed window (sign-in failures per login).
 * In memory: a restart forgets them, which costs an attacker nothing they
 * could not get by waiting out the window.
 */
export class FailureLimiter {
  private readonly windows = new Map<string, { count: number; start: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}

  /** Seconds until `key` may try again, or 0 when it may now. */
  retryAfter(key: string): number {
    const w = this.windows.get(key);
    if (!w) return 0;
    const elapsed = this.now() - w.start;
    if (elapsed >= this.windowMs) {
      this.windows.delete(key);
      return 0;
    }
    return w.count >= this.max ? Math.ceil((this.windowMs - elapsed) / 1000) : 0;
  }

  fail(key: string): void {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) this.windows.set(key, { count: 1, start: t });
    else w.count++;
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}

/* ---------------------------------------------------------------- rows */

export type Role = "owner" | "member";

/** An account on a multi-user app (spec `account`, plus its password hash). */
export interface AccountRow {
  id: string;
  name: string;
  login: string;
  role: Role;
  active: boolean;
  createdAt: string;
  passwordHash: string;
}

export interface SessionRow {
  principal: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteRow {
  role: Role;
  createdAt: string;
  expiresAt: string;
}

/** A login as stored and compared: trimmed, lower-cased. */
export function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}
