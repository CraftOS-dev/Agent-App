import { createA2App, MemoryBinding, OperationError } from "../../../adapters/adapter-core/dist/index.js";
import { schema } from "../template/a2app.schema.mjs";

// The real starter runner and protocol adapter, with disposable record storage.
export function triageFixture(token = "triage-test") {
  let app;
  const binding = new MemoryBinding({ appId: "triage-test", entities: schema.entities });
  const toolbox = {
    store: {
      get: (entity, id) => structuredClone(binding.getRecord(entity, id)),
      put: (entity, record) => Object.assign(binding.getRecord(entity, record.id), record),
    },
    trigger: (type, payload, capability) => app.trigger({ type, payload, capability }),
    getTask: (id) => app.store.getTask(id),
    error: (status, code, message, extra) => new OperationError(code, message, status, extra),
  };
  binding.runOperation = (name, args, ctx) => schema.operationRunners[name](args, ctx, toolbox);
  app = createA2App(binding, {
    operations: schema.operations, events: schema.events, modules: [{ name: "planning" }],
    credentials: [{ token, credentialId: "test", principal: "owner", scopes: ["*"] }],
  });
  const call = (method, path, body = {}) => app.handle({ method, path, body, query: {}, headers: { "x-a2app-token": token } });
  return { app, binding, toolbox, call, ask: () => call("POST", "/api/ops/request-triage", { task: "task_welcome" }) };
}
