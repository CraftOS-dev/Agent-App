/**
 * @a2app/adapter-core — the stack-agnostic A2App served surface.
 *
 * `app + adapter = agentic app`. This package IS the adapter's front face and
 * adapter-owned state; a backend author supplies only a {@link Binding} (the
 * back face) mapping their stack's schema and record store onto the protocol
 * vocabulary. The pure validation rules come from `@a2app/rules`, shared
 * verbatim so every backend rejects identical payloads identically.
 *
 * `app + A2App adapter = Agent App`: this package is the adapter's UNIVERSAL
 * part, byte-identical in every app on this stack. What differs per app — its
 * modules, its declared operations, its identity and pipeline — is the app part,
 * supplied through {@link A2AppConfig} and the binding.
 */
export { createA2App, ADAPTER_CORE_VERSION } from "./server.js";
export type { A2App } from "./server.js";
export { MemoryBinding } from "./memory.js";
export type { MemoryBindingOptions, MemoryEntitySpec, OperationRunner } from "./memory.js";
export { a2appMiddleware, createA2AppServer, toA2AppRequest } from "./http.js";
export type { NextHandler } from "./http.js";
/** Serving the human View: cache-correct static files (ETag / Last-Modified /
 *  Cache-Control, conditional requests honoured) and the `appVersion` marker over
 *  the bytes served, which is what lets an already-open tab notice a UI change
 *  `schemaVersion` is blind to. */
export { createStaticView, fingerprintPaths, DEFAULT_MIME } from "./static.js";
export type { StaticView, StaticViewOptions } from "./static.js";
export { InMemoryStateStore, FileStateStore, newCredentialId } from "./store.js";
export type { StateStore, StoredTask, StoredEvent } from "./store.js";
export { RateLimiter, DEFAULT_RATE_LIMITS } from "./rate.js";
export type { RateLimits, RouteClass, RateDecision } from "./rate.js";
export { approvalKey, canonicalize, sha256Prefixed } from "./canon.js";
/** Navigational describe: the level builders, the model check the build gate
 *  reuses so it can never pass a model the adapter would refuse, and the size
 *  measurement the per-response budget is stated in. */
export {
  buildRoot,
  buildModule,
  buildEntity,
  buildRecord,
  buildRelation,
  buildFind,
  modelProblems,
  levelSize,
  FULL_ACCESS,
  NO_ACCESS,
} from "./describe.js";
export type { Access, DescribeDeps } from "./describe.js";
export * from "./types.js";
