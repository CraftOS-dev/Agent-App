/**
 * Describe cache, keyed by the app's own `schemaVersion`.
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
 * - **Keyed by `schemaVersion`, never by time.** The app tells us when its model
 *   changed; guessing with a TTL would either serve a stale model (writes fail
 *   inexplicably) or discard a valid one (the budget is lost). There is no
 *   expiry here at all, by design.
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
   * Open the cache for one app at one schema version.
   *
   * A file belonging to a different app or a superseded schema is discarded
   * wholesale rather than merged: a per-entry version would let one stale level
   * survive a model change and be read alongside fresh ones, which is exactly
   * the "never write against a stale schema" failure the protocol names.
   */
  static open(appDir: string, appId: string, schemaVersion: string): DescribeCache {
    const file = join(appDir, ".a2app", "describe-cache.json");
    const empty: CacheFile = { appId, schemaVersion, levels: {} };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
      if (parsed.appId === appId && parsed.schemaVersion === schemaVersion && parsed.levels) {
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
