/**
 * @a2app/sdk — the TypeScript client SDK for the A2App protocol (v0.1).
 *
 * The whole agent-facing surface any harness needs to operate an Agent App:
 * identity + describe (context by pull), guarded reads/writes, declared
 * operations, the app→agent task/event plane, and whoami/context — plus the
 * client-side coercion (dates, labels) that makes a correct write cost at most
 * two round trips.
 */
export const SDK_VERSION = "0.1.0";

export * from "./types.js";
export * from "./client.js";
export * from "./coerce.js";
