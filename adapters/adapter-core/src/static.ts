/**
 * Static asset serving for an app's View — the framework's answer to the stale
 * tab.
 *
 * Two jobs, deliberately in one place because they answer the same question
 * ("has the code this browser is running changed?") from two directions:
 *
 * 1. **Correct HTTP validators.** Every response carries `ETag`, `Last-Modified`
 *    and an explicit `Cache-Control`, and conditional requests are honoured. A
 *    response with NO validators is the worst possible answer for an app that is
 *    edited in place: the browser has nothing to revalidate against, so whether a
 *    plain reload re-fetches is heuristic. With validators, a reload always
 *    re-checks and an unchanged asset costs a 304 with no body.
 *
 * 2. **A version marker for the served tree** ({@link StaticView.version}). The
 *    app's `schemaVersion` fingerprints the MODEL — entities and operations —
 *    and is deliberately blind to the View: a new button, a CSS change, or new
 *    copy leaves it byte-identical. So it cannot answer "is the tab stale?".
 *    `version()` fingerprints the bytes actually served, which is exactly the
 *    code the tab is running. Published as identity's `appVersion`, it lets a
 *    page notice a change `schemaVersion` cannot see.
 *
 * `Cache-Control: no-cache` is "cache it, but revalidate before every use" — NOT
 * "do not cache". It is the right default here because these are plain, unhashed
 * filenames served from disk and edited in place: an asset's URL never changes
 * when its content does, so a freshness lifetime of any length would serve stale
 * code for that long. Revalidation is cheap (a 304 carries no body); a stack that
 * emits content-hashed filenames should override `cacheControl` per its own
 * pipeline.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

/** Content types for the file kinds a dependency-free View is built from. */
export const DEFAULT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface StaticViewOptions {
  /** Exact URL paths served from a file outside `dir` — how the framework mounts
   *  its own browser-side helpers without putting a system-owned file inside the
   *  app-owned View directory. Alias targets count towards
   *  {@link StaticView.version}: they are code the tab runs too. */
  aliases?: Record<string, string>;
  /** Extra files or directories folded into `version()` — app source that shapes
   *  the served app without being served itself. */
  fingerprintPaths?: string[];
  /** An opaque string mixed into `version()`, e.g. `manifest.appVersion`, so an
   *  author can move the marker deliberately. */
  versionSalt?: string;
  /** Default `no-cache` — see the module docstring before changing it. */
  cacheControl?: string;
  mime?: Record<string, string>;
  /** Served for a request that lands on the root. Default `index.html`. */
  indexFile?: string;
  /** How long a computed `version()` is reused before the tree is re-hashed.
   *  Every open tab polls identity, so this bounds the cost of that polling; it
   *  is not a correctness knob (a promote is followed by a restart). */
  versionTtlMs?: number;
  now?: () => number;
}

export interface StaticView {
  /** A `createA2AppServer` fallthrough: serves `dir`, else 404. */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** `av_…` over the served bytes. Stable for identical content, and it moves for
   *  any change — including one `schemaVersion` cannot see. */
  version: () => string;
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ a2app: true, ok: false, code: "not_found", message: "No such route." }));
}

/** Every regular file under `path` (a file is itself), sorted, never following a
 *  symlink — the same containment rule the ownership canon walks with. */
function filesUnder(path: string): string[] {
  const out: string[] = [];
  const stack = [path];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current) || !existsSync(current)) continue;
    seen.add(current);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) for (const name of readdirSync(current)) stack.push(join(current, name));
    else out.push(current);
  }
  return out.sort();
}

/**
 * A content fingerprint over a set of files and directories.
 *
 * Content, not mtime: a `touch`, a checkout, or a re-copy of identical bytes must
 * NOT look like a new version — an app that cried "update available" every time
 * its files were re-stamped would train users to dismiss the one notice that
 * matters. Paths are hashed alongside content so that renaming a file, or adding
 * an empty one, moves the fingerprint too.
 */
export function fingerprintPaths(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    const root = resolve(path);
    for (const file of filesUnder(root)) {
      // Relative to the entry, so the same tree fingerprints identically from a
      // different absolute location (a dev clone, a restored backup).
      hash.update(file.slice(root.length).split(sep).join("/"));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

/** Parse an `If-None-Match` list. `*` matches anything; weak comparison is the
 *  correct one for a conditional GET (RFC 9110 13.1.2), so `W/` is stripped. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const strip = (s: string): string => s.trim().replace(/^W\//, "");
  return header.split(",").some((candidate) => {
    const value = strip(candidate);
    return value === "*" || value === strip(etag);
  });
}

/**
 * Build a static-file fallthrough for `dir`, plus the version marker for what it
 * serves.
 */
export function createStaticView(dir: string, options: StaticViewOptions = {}): StaticView {
  const root = resolve(dir);
  const aliases = options.aliases ?? {};
  const mime = { ...DEFAULT_MIME, ...(options.mime ?? {}) };
  const cacheControl = options.cacheControl ?? "no-cache";
  const indexFile = options.indexFile ?? "index.html";
  const ttl = options.versionTtlMs ?? 1000;
  const now = options.now ?? ((): number => Date.now());
  const versioned = [root, ...Object.values(aliases), ...(options.fingerprintPaths ?? [])];

  let cached: { value: string; at: number } | null = null;
  function version(): string {
    const at = now();
    if (cached !== null && at - cached.at < ttl) return cached.value;
    const salt = options.versionSalt === undefined ? "" : `${options.versionSalt}\0`;
    const digest = createHash("sha256").update(salt).update(fingerprintPaths(versioned)).digest("hex");
    cached = { value: `av_${digest.slice(0, 16)}`, at };
    return cached.value;
  }

  /** The file this request names, or null when there is none to serve. Returns
   *  null rather than throwing for every hostile shape (traversal, a bad percent
   *  escape, a directory) so the caller answers one honest 404. */
  function resolveFile(rawPath: string): string | null {
    const alias = aliases[rawPath];
    if (alias !== undefined) return existsSync(alias) && statSync(alias).isFile() ? alias : null;

    let rel: string;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      return null; // malformed percent-escape — not a path we can have
    }
    if (rel === "/" || rel === "") rel = `/${indexFile}`;
    if (rel.includes("\0")) return null;
    const file = normalize(join(root, rel));
    // Containment: `startsWith(root)` alone would also accept a sibling whose
    // name merely begins with root's (…/public-backup), so the separator is part
    // of the test.
    if (file !== root && !file.startsWith(root + sep)) return null;
    // A directory is not a file: existsSync() is true for one, and reading it
    // would throw EISDIR and 500 a request that is simply a miss.
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    return file;
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "application/json", allow: "GET, HEAD" });
      res.end(
        JSON.stringify({ a2app: true, ok: false, code: "method_not_allowed", message: "Static assets are GET-only." }),
      );
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const file = resolveFile(url.pathname);
    if (file === null) {
      notFound(res);
      return;
    }

    const body = readFileSync(file);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
    const lastModified = statSync(file).mtime;
    const headers: Record<string, string> = {
      "content-type": mime[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": cacheControl,
      etag,
      "last-modified": lastModified.toUTCString(),
    };

    // ETag wins where both validators are present: it compares content, while
    // If-Modified-Since compares a whole-second timestamp that an edit inside the
    // same second cannot move.
    const inm = req.headers["if-none-match"];
    let fresh = matchesEtag(Array.isArray(inm) ? inm.join(",") : inm, etag);
    if (!fresh && inm === undefined) {
      const ims = Date.parse(String(req.headers["if-modified-since"] ?? ""));
      fresh = !Number.isNaN(ims) && Math.floor(lastModified.getTime() / 1000) * 1000 <= ims;
    }
    if (fresh) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    res.writeHead(200, { ...headers, "content-length": String(body.byteLength) });
    res.end(method === "HEAD" ? undefined : body);
  }

  return { handler, version };
}
