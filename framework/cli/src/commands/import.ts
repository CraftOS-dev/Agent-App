/**
 * agent-app <dir> import [--blueprint <id|path>] [--name "..."] [--port N] [--keep-data]
 *
 * Bring an existing app directory (an extracted Agent App zip, or a codebase
 * already carrying framework files) into the framework as a FRESH local app.
 * Imports are untrusted supply chain, so this command makes the untrusted parts
 * safe MECHANICALLY rather than trusting the source:
 *
 *   1. STRIP credentials — a shipped `.agent-token` is an attacker's known key.
 *   2. Assign a NEW identity + a fresh, collision-free port — the source's id and
 *      port belong to the exporter, not to this machine.
 *   3. Re-vendor the system/adapter files from a TRUSTED local toolkit (via
 *      --blueprint), so imported system CODE is replaced with known-good code,
 *      not merely re-hashed. Then re-record the ownership canon.
 *
 * The caller then runs `agent-app <dir> validate` + `serve`, and a verifier
 * agent runs the walk-verify skill: an import is fully re-verified, never
 * trusted on origin.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSystemHashes } from "../lib/canon.js";
import { flag, hasFlag } from "../lib/args.js";
import { mintAgentToken, stripCredentials } from "../lib/credential.js";
import { writeFileAtomic } from "../lib/home.js";
import { loadProject, UsageError } from "../lib/project.js";
import { adapterVersionOf, projectToolkit, recordProjectToolkit, resolveToolkit, vendorPaths, type ResolvedToolkit } from "../lib/toolkit.js";
import { canonPaths } from "../lib/canon.js";
import { reserveApp, unregister } from "../lib/registry.js";
import { randomBytes } from "node:crypto";
import { log } from "../lib/log.js";

export async function run(args: string[], dir: string): Promise<number> {
  const requested = flag(args, "port");
  let preferred: number | undefined;
  if (requested !== undefined) {
    const n = Number(requested);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new UsageError(`--port must be an integer between 1 and 65535 (got "${requested}")`);
    }
    preferred = n;
  }

  // Must already carry the framework files (an extracted Agent App). A foreign
  // codebase with no manifest is scaffolded first, not imported.
  const project = loadProject(dir);
  const appDir = project.dir;

  // 1. Strip shipped credentials FIRST — before the app is registered or launched.
  const stripped = stripCredentials(appDir);
  if (stripped > 0) log.step(`stripped ${stripped} shipped credential file(s)`);

  let reserved = false;
  try {
    // 2. Fresh identity + port. The imported id/port belong to the exporter.
    const manifestPath = join(appDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const oldId = manifest.id;
    manifest.id = randomBytes(6).toString("hex");
    const name = flag(args, "name") ?? (typeof manifest.name === "string" ? manifest.name : "Imported App");
    manifest.name = name;

    // 3. Choose the trusted toolkit to re-vendor from.
    let tk: ResolvedToolkit | null = null;
    const blueprintId = flag(args, "blueprint");
    if (blueprintId !== undefined) {
      try {
        tk = resolveToolkit(blueprintId);
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      recordProjectToolkit(appDir, tk);
    } else {
      tk = projectToolkit(appDir);
      if (tk !== null) {
        log.warn(
          "re-vendoring from the app's OWN recorded toolkit — pass --blueprint <trusted-id> to replace " +
            "imported system code with a known-good toolkit's instead of trusting what shipped.",
        );
      }
    }

    const assigned = await reserveApp(
      {
        id: manifest.id as string,
        name,
        path: appDir,
        ...(tk ? { blueprint: tk.manifest.id } : {}),
        createdAt: new Date().toISOString(),
      },
      preferred,
    );
    reserved = true;
    manifest.port = assigned;

    if (tk !== null) {
      // Replace system/adapter code with the trusted toolkit's, then re-canonize
      // so the canon reflects known-good code — not the imported bytes.
      const written = vendorPaths(tk, appDir, tk.manifest.systemPaths);
      manifest.adapterVersion = adapterVersionOf(tk);
      writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      writeSystemHashes(appDir, tk.manifest.systemPaths);
      log.step(`re-vendored ${written.length} system file(s) from trusted toolkit "${tk.manifest.id}"`);
    } else {
      // No toolkit to re-vendor from: we cannot replace imported system code.
      // Record the canon from the existing declared system paths so drift is at
      // least detectable, and warn loudly that the code was not replaced.
      writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      const existing = canonPaths(appDir);
      if (existing.length > 0) writeSystemHashes(appDir, existing);
      log.warn(
        "no trusted toolkit — imported system code was NOT replaced, only re-canonized. " +
          "Review the adapter/system files before serving, or re-run with --blueprint.",
      );
    }

    // 4. Mint a fresh local credential so operate commands work immediately.
    mintAgentToken(appDir);

    log.ok(
      `imported "${name}" (fresh id ${manifest.id as string}, was ${String(oldId)}) on port ${assigned} at ${appDir}`,
    );
    log.raw(
      JSON.stringify(
        { ok: true, id: manifest.id, previousId: oldId, dir: appDir, port: assigned, next: ["validate", "serve", "walk-verify skill (verifier agent)"] },
        null,
        2,
      ),
    );
    return 0;
  } catch (err) {
    if (reserved) {
      try {
        await unregister(appDir);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}
