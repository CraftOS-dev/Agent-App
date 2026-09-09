/**
 * Manifest ownership: which keys belong to the APP and which to the TOOLKIT.
 *
 * `manifest.json` is a system-owned, canon-covered file, but it is not a
 * toolkit file — it is the app's identity. Re-vendoring it wholesale from a
 * blueprint template destroys the app (its id, port, and the modules every
 * entity and operation names); keeping it wholesale from the app defeats the
 * point of re-vendoring, because `pipeline.build` and `pipeline.start` are shell
 * commands the gate and `serve` execute.
 *
 * So the file is merged, not copied: identity comes from the app, executable
 * configuration comes from the trusted toolkit. Both `toolkit-sync` and
 * `import` go through {@link mergeManifest} so the two can never drift.
 */

/** The framework version stamped into every app's manifest. */
export const AGENT_APP_VERSION = "0.1.0";

/**
 * Keys that belong to the app and survive a re-vendor.
 *
 * Everything NOT listed here is taken from the toolkit — most importantly
 * `pipeline`, whose `build`/`start` strings are executed. An imported app's
 * pipeline is untrusted input; re-vendoring from a trusted toolkit has to
 * replace it, or the "trusted toolkit" only replaced the code around it.
 *
 * `modules` is app-owned because an app's modules ARE the app: the creator
 * flow declares them here, and they name nothing executable.
 */
export const APP_OWNED_MANIFEST_KEYS = [
  "id",
  "name",
  "port",
  "authMode",
  "appVersion",
  "modules",
  "modificationLock",
  "capabilities",
] as const;

export type Manifestish = Record<string, unknown>;

/**
 * Merge an app's manifest onto a toolkit template's.
 *
 * @param template  the toolkit's manifest (trusted; source of `pipeline`)
 * @param existing  the app's current manifest (source of identity + modules)
 * @param adapterVersion  stamped from the toolkit's adapter, when known
 */
export function mergeManifest(
  template: Manifestish,
  existing: Manifestish,
  adapterVersion?: string,
): Manifestish {
  const merged: Manifestish = { ...template };
  for (const key of APP_OWNED_MANIFEST_KEYS) {
    // Only carry a key the app actually has: a hand-assembled app may be
    // missing one, and writing `undefined` over a template default would
    // serialize as a dropped key rather than the default.
    if (Object.prototype.hasOwnProperty.call(existing, key)) merged[key] = existing[key];
  }
  merged.agentAppVersion = AGENT_APP_VERSION;
  if (adapterVersion !== undefined) merged.adapterVersion = adapterVersion;
  return merged;
}
