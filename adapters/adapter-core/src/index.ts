/**
 * @a2app/adapter-core — the stack-agnostic A2App served surface.
 *
 * `app + adapter = agentic app`. This package IS the adapter's front face and
 * adapter-owned state; a backend author supplies only a {@link Binding} (the
 * back face) mapping their stack's schema and record store onto the protocol
 * vocabulary. The pure validation rules come from `@a2app/rules`, shared
 * verbatim so every backend rejects identical payloads identically.
 */
export { createA2App, ADAPTER_CORE_VERSION } from "./server.js";
export type { A2App } from "./server.js";
export { MemoryBinding } from "./memory.js";
export type { MemoryBindingOptions, MemoryEntitySpec, OperationRunner } from "./memory.js";
export { a2appMiddleware, createA2AppServer, toA2AppRequest } from "./http.js";
export type { NextHandler } from "./http.js";
export { InMemoryStateStore, FileStateStore, newCredentialId } from "./store.js";
export type { StateStore, StoredTask, StoredEvent } from "./store.js";
export { RateLimiter, DEFAULT_RATE_LIMITS } from "./rate.js";
export type { RateLimits, RouteClass, RateDecision } from "./rate.js";
export { approvalKey, canonicalize, sha256Prefixed } from "./canon.js";
export * from "./types.js";
