/**
 * Describe cache, keyed by the app's own version markers.
 *
 * The protocol tells clients to cache describe against `schemaVersion` and
 * re-fetch when it changes (A2APP-SPEC 2). For a navigational surface that
 * instruction is not an optimisation, it is what makes the budget reachable: a
 * write is allowed two round trips, and an uncached walk would spend them both
 * before sending anything.
 *
 * The cache lives on disk because the CLI is one process per invocation — an
 * in-memory cache would be cold on every command and would buy nothing.
 *
 * Correctness rules, in order of importance:
 *
 * - **Keyed by the app's version markers, never by time.** The app tells us when
 *   it changed; guessing with a TTL would either serve a stale model (writes fail
 *   inexplicably) or discard a valid one (the budget is lost). There is no
 *   expiry here at all, by design.
 * - **`schemaVersion` alone is not a complete key.** It fingerprints the model —
 *   entity fields, operation names, params, flags — and deliberately not every
 *   attribute describe PUBLISHES. An operation's `description` is published (it
 *   is the one-line summary an agent reads to choose an operation) but is not in
 *   the fingerprint, so rewording one leaves `schemaVersion` byte-identical and a
 *   `schemaVersion`-only cache keeps serving the old wording indefinitely — the
 *   agent reads a description the app has stopped giving. `appVersion` covers the
 *   app's code, moves for exactly that edit, and is folded into the key here.
 *   It is an optional extension: an app that does not publish one caches on
 *   `schemaVersion` alone, exactly as before.
 * - **A cache miss is never an error.** Every entry is re-derivable from the
 *   app, so a corrupt, unreadable, or unwritable cache degrades to fetching.
 *   An operate command must not fail because a cache file is bad.
 * - **Scoped per app id**, so two apps on one machine cannot read each other's
 *   levels even if they briefly share a directory.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DescribeLevel } from "@a2app/sdk";

interface CacheFile {
  appId: string;
  schemaVersion: string;
  /** identity's `appVersion`, or "" from an app that publishes none */
  appVersion: string;
  /** describe path ("" for root) → the level served for it */
  levels: Record<string, DescribeLevel>;
}

export class DescribeCache {
  private data: CacheFile;
  private dirty = false;

  private constructor(
    private readonly file: string,
    data: CacheFile,
  ) {
    this.data = data;
  }

  /**
   * Open the cache for one app at one version of that app.
   *
   * A file belonging to a different app, a superseded schema, or a superseded
   * build is discarded wholesale rather than merged: a per-entry version would
   * let one stale level survive a change and be read alongside fresh ones, which
   * is exactly the "never write against a stale schema" failure the protocol
   * names.
   *
   * A cache written before `appVersion` existed carries none, so it fails the
   * comparison and is discarded once — a single re-fetch, not an error.
   */
  static open(appDir: string, appId: string, schemaVersion: string, appVersion?: string | null): DescribeCache {
    const file = join(appDir, ".a2app", "describe-cache.json");
    const version = appVersion ?? "";
    const empty: CacheFile = { appId, schemaVersion, appVersion: version, levels: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
      if (
        parsed.appId === appId &&
        parsed.schemaVersion === schemaVersion &&
        parsed.appVersion === version &&
        parsed.levels
      ) {
        return new DescribeCache(file, parsed);
      }
    } catch {
      // No cache, unreadable, or not ours. Either way: start clean.
    }
    return new DescribeCache(file, empty);
  }

  get(path: string): DescribeLevel | undefined {
    return this.data.levels[path];
  }

  put(path: string, level: DescribeLevel): void {
    this.data.levels[path] = level;
    this.dirty = true;
  }

  /**
   * Persist if anything changed. Writes through a temporary file and renames, so
   * a concurrent reader sees either the previous cache or the new one and never
   * a half-written file. Failure is silent for the reason given above: losing a
   * cache write must not fail the command that populated it.
   */
  flush(): void {
    if (!this.dirty) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
    }
  }
}
