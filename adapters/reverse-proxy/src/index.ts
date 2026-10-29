/**
 * @a2app/reverse-proxy — the sidecar adapter form, for foreign apps adopted
 * as-is: any HTTP app, with no framework files and no adapter of its own.
 *
 * It serves the A2App surface in front of the app and forwards each declared
 * operation to one of the app's own endpoints. Foreign apps are OPERATE-ONLY:
 * the data model is not mapped, so `describe` reports `entities: {}` by design
 * and operations are the only guarded surface. Everything else — identity, the
 * error envelope, approval for destructive ops, accounts, delegated
 * credentials, the ceiling, device sign-in, task credentials, the
 * origin/credential/scope chain — is shared verbatim from `@a2app/adapter-core`.
 *
 * Two ways in:
 * - {@link createReverseProxy}: the library, for a host that already runs the
 *   app and serves HTTP itself;
 * - {@link startSidecar} (and the `a2app-sidecar` bin): the runnable sidecar,
 *   which reads an app directory's `sidecar.json`, starts the app, waits for it
 *   to answer, and serves the surface on the app's port.
 */
export {
  createReverseProxy,
  operationDecls,
  sendOf,
  REVERSE_PROXY_ADAPTER_VERSION,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  MAX_UPSTREAM_RESPONSE_BYTES,
  PROXY_METHODS,
} from "./proxy.js";
export type { ProxyMethod, ProxyOperation, ReverseProxyConfig, ReverseProxyOptions } from "./proxy.js";
export { loadAdoptedApp, SIDECAR_FILE, OPERATIONS_FILE, MANIFEST_FILE, DEFAULT_START_TIMEOUT_MS } from "./config.js";
export type { AdoptedApp, AdoptedManifest, LoadResult, OperationMapping, SidecarSpec, UpstreamSpec } from "./config.js";
export { startSidecar, SidecarConfigError } from "./sidecar.js";
export type { Sidecar, SidecarClosed, SidecarLog, SidecarOptions } from "./sidecar.js";
